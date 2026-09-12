//! Pure (N-API-free) read of a process's creation time, used by the removal
//! path to verify a lock's recorded process before signalling it. Kept free of
//! any `napi` types so it is directly unit-testable under a plain `cargo test`
//! binary; the thin `#[napi]` wrapper lives in `lib.rs`. Windows reads
//! `GetProcessTimes` through `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`;
//! every other platform reports no reading.

#[cfg(any(windows, test))]
fn filetime_to_epoch_ms(low: u32, high: u32) -> Option<i64> {
    let ticks = (u64::from(high) << 32) | u64::from(low);
    ticks
        .checked_sub(116_444_736_000_000_000)
        .map(|value| (value / 10_000) as i64)
}

#[cfg(windows)]
pub fn read(pid: u32) -> Result<Option<i64>, String> {
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn GetProcessTimes(
            handle: *mut c_void,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return Err(format!("OpenProcess: {}", std::io::Error::last_os_error()));
    }
    let mut creation = FileTime::default();
    let mut exit = FileTime::default();
    let mut kernel = FileTime::default();
    let mut user = FileTime::default();
    let success =
        unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
    let result = if success == 0 {
        Err(format!(
            "GetProcessTimes: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(filetime_to_epoch_ms(creation.low, creation.high))
    };
    unsafe { CloseHandle(handle) };
    result
}

#[cfg(not(windows))]
pub fn read(_pid: u32) -> Result<Option<i64>, String> {
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_filetime_to_unix_milliseconds() {
        let ticks = 116_444_736_000_000_000u64 + 1_234_567 * 10_000 + 9999;
        assert_eq!(
            filetime_to_epoch_ms(ticks as u32, (ticks >> 32) as u32),
            Some(1_234_567)
        );
        assert_eq!(filetime_to_epoch_ms(0, 0), None);
    }

    #[cfg(windows)]
    #[test]
    fn reads_current_process_and_refuses_invalid_pid() {
        let start = read(std::process::id())
            .expect("current process is queryable")
            .expect("current process has a creation time");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert!(start <= now);
        assert!(start > 0);
        assert_eq!(read(std::process::id()), Ok(Some(start)));
        assert!(read(0).unwrap_err().starts_with("OpenProcess:"));
        assert!(read(u32::MAX).unwrap_err().starts_with("OpenProcess:"));
    }
}
