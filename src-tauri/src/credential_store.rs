#[cfg(windows)]
mod platform {
    use std::{ffi::c_void, ptr};

    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    fn target(service: &str) -> Result<Vec<u16>, String> {
        if !matches!(service, "qoder-pat" | "trae-session" | "trae-token") {
            return Err("未知的凭据类型".into());
        }
        Ok(wide(&format!("QuotaHalo/{service}")))
    }

    pub fn write(service: &str, value: &str) -> Result<(), String> {
        if value.is_empty() || value.len() > 2560 {
            return Err("凭据为空或过长".into());
        }
        let mut target = target(service)?;
        let mut username = wide("QuotaHalo");
        let mut bytes = value.as_bytes().to_vec();
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            CredentialBlobSize: bytes.len() as u32,
            CredentialBlob: bytes.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: username.as_mut_ptr(),
            ..Default::default()
        };
        let ok = unsafe { CredWriteW(&credential, 0) } != 0;
        bytes.fill(0);
        if ok {
            Ok(())
        } else {
            Err("Windows 无法保存登录凭据".into())
        }
    }

    pub fn read(service: &str) -> Result<Option<String>, String> {
        let target = target(service)?;
        let mut pointer: *mut CREDENTIALW = ptr::null_mut();
        if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut pointer) } == 0 {
            let code = std::io::Error::last_os_error().raw_os_error();
            return if code == Some(1168) {
                Ok(None)
            } else {
                Err("Windows 无法读取登录凭据".into())
            };
        }
        let result = unsafe {
            let credential = &*pointer;
            if credential.CredentialBlobSize == 0 || credential.CredentialBlob.is_null() {
                Err("登录凭据为空".to_string())
            } else {
                let bytes = std::slice::from_raw_parts(
                    credential.CredentialBlob,
                    credential.CredentialBlobSize as usize,
                );
                String::from_utf8(bytes.to_vec()).map_err(|_| "登录凭据编码无效".to_string())
            }
        };
        unsafe { CredFree(pointer as *const c_void) };
        result.map(Some)
    }

    pub fn delete(service: &str) -> Result<(), String> {
        let target = target(service)?;
        if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } != 0
            || std::io::Error::last_os_error().raw_os_error() == Some(1168)
        {
            Ok(())
        } else {
            Err("Windows 无法删除登录凭据".into())
        }
    }
}

#[cfg(windows)]
pub use platform::{delete, read, write};

#[cfg(not(windows))]
pub fn write(_: &str, _: &str) -> Result<(), String> {
    Err("仅支持 Windows 凭据管理器".into())
}
#[cfg(not(windows))]
pub fn read(_: &str) -> Result<Option<String>, String> {
    Ok(None)
}
#[cfg(not(windows))]
pub fn delete(_: &str) -> Result<(), String> {
    Ok(())
}
