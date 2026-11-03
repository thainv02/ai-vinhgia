//! Windows Job Object: gán chính AI Vinh Gia.exe vào một job có KILL_ON_JOB_CLOSE ngay đầu main().
//! Mọi tiến trình con sinh sau đó (node server, worker, ffmpeg, gwr, Edge ẩn của gwr) tự thuộc job;
//! AI Vinh Gia.exe thoát vì bất kỳ lý do gì (đóng, crash, bị kill) thì Windows đóng handle cuối của job và kill cả cây.

#[cfg(windows)]
pub fn assign_self_to_kill_on_close_job() -> Result<(), String> {
    use std::{ffi::c_void, mem, ptr};
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    unsafe {
        // lpJobAttributes = NULL: handle không kế thừa, chỉ tiến trình này giữ
        let job = CreateJobObjectW(ptr::null(), ptr::null());
        if job.is_null() {
            return Err(format!("CreateJobObjectW lỗi {}", GetLastError()));
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
        // Không bật BREAKAWAY_OK: tiến trình con không thoát ra khỏi job được
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const c_void,
            mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
        {
            return Err(format!("SetInformationJobObject lỗi {}", GetLastError()));
        }
        if AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
            return Err(format!("AssignProcessToJobObject lỗi {}", GetLastError()));
        }
        // Cố ý không đóng handle: job sống tới khi tiến trình này kết thúc
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn assign_self_to_kill_on_close_job() -> Result<(), String> {
    Ok(())
}
