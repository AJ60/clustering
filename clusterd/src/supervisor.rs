//! Process Lifecycle Supervisor:
//! - On Windows (`#[cfg(target_os = "windows")]`): Attaches child `llama-server.exe` and
//!   `rpc-server.exe` processes to a Windows Job Object configured with
//!   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (0x2000) so closing `clusterd.exe` guarantees
//!   zero zombie processes locking ports 8080 or 50052.
//! - On Linux / macOS / Unix (`#[cfg(unix)]`): Places child processes into a dedicated
//!   process group and issues `killpg(pgid, SIGTERM)` with a graceful shutdown window
//!   before escalating to `SIGKILL` on Drop.

use std::io;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub struct ManagedProcessGroup {
    children: Vec<Child>,
    #[cfg(target_os = "windows")]
    job_handle: *mut core::ffi::c_void,
}

unsafe impl Send for ManagedProcessGroup {}
unsafe impl Sync for ManagedProcessGroup {}

#[cfg(target_os = "windows")]
mod win_job {
    use core::ffi::c_void;
    use std::io;
    use std::mem;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    pub type HANDLE = *mut c_void;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x00002000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;

    #[repr(C)]
    #[derive(Copy, Clone, Default)]
    #[allow(non_camel_case_types, dead_code)]
    struct IO_COUNTERS {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Copy, Clone, Default)]
    #[allow(non_camel_case_types, dead_code)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Copy, Clone, Default)]
    #[allow(non_camel_case_types, dead_code)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        basic_limit_information: JOBOBJECT_BASIC_LIMIT_INFORMATION,
        io_info: IO_COUNTERS,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(lp_job_attributes: *mut c_void, lp_name: *const u16) -> HANDLE;
        fn SetInformationJobObject(
            h_job: HANDLE,
            job_object_information_class: i32,
            lp_job_object_information: *const c_void,
            cb_job_object_information_length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(h_job: HANDLE, h_process: HANDLE) -> i32;
        fn TerminateJobObject(h_job: HANDLE, u_exit_code: u32) -> i32;
        fn CloseHandle(h_object: HANDLE) -> i32;
    }

    pub fn create_kill_on_close_job() -> io::Result<HANDLE> {
        unsafe {
            let job = CreateJobObjectW(core::ptr::null_mut(), core::ptr::null());
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            let ok = SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                &info as *const _ as *const c_void,
                mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                let err = io::Error::last_os_error();
                CloseHandle(job);
                return Err(err);
            }
            Ok(job)
        }
    }

    pub fn assign_child(job: HANDLE, child: &Child) -> io::Result<()> {
        if job.is_null() {
            return Ok(());
        }
        unsafe {
            let raw_proc = child.as_raw_handle() as HANDLE;
            if AssignProcessToJobObject(job, raw_proc) == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }

    pub fn terminate_and_close_job(job: HANDLE) {
        if !job.is_null() {
            unsafe {
                TerminateJobObject(job, 0);
                CloseHandle(job);
            }
        }
    }
}

impl ManagedProcessGroup {
    pub fn new() -> io::Result<Self> {
        #[cfg(target_os = "windows")]
        {
            let job_handle = win_job::create_kill_on_close_job()?;
            Ok(Self {
                children: Vec::new(),
                job_handle,
            })
        }
        #[cfg(not(target_os = "windows"))]
        {
            Ok(Self {
                children: Vec::new(),
            })
        }
    }

    pub fn spawn_managed(&mut self, program: &str, args: &[String]) -> io::Result<u32> {
        self.spawn_managed_with_env(program, args, &[])
    }

    pub fn spawn_managed_with_env(
        &mut self,
        program: &str,
        args: &[String],
        envs: &[(&str, &str)],
    ) -> io::Result<u32> {
        let mut cmd = Command::new(program);
        cmd.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        for (k, v) in envs {
            cmd.env(k, v);
        }

        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        let child = cmd.spawn()?;
        let pid = child.id();

        #[cfg(target_os = "windows")]
        {
            // Attach to Windows Job Object; ignore error if nested inside a legacy pre-Win8 job
            let _ = win_job::assign_child(self.job_handle, &child);
        }

        self.children.push(child);
        Ok(pid)
    }

    pub fn terminate_all(&mut self) {
        #[cfg(unix)]
        {
            extern "C" {
                fn killpg(pgrp: i32, sig: i32) -> i32;
            }
            const SIGTERM: i32 = 15;
            // Phase 1: Send SIGTERM only to still-running child process groups (avoids recycled-PID signals)
            for child in &mut self.children {
                if matches!(child.try_wait(), Ok(None)) {
                    let pgid = child.id() as i32;
                    if pgid > 0 {
                        unsafe {
                            killpg(pgid, SIGTERM);
                        }
                    }
                }
            }
            // Wait up to 250ms for graceful exit before escalating to SIGKILL
            let deadline = Instant::now() + Duration::from_millis(250);
            while Instant::now() < deadline {
                let all_done = self
                    .children
                    .iter_mut()
                    .all(|c| !matches!(c.try_wait(), Ok(None)));
                if all_done {
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            // Phase 2: Force kill any remaining stubborn children
            for child in &mut self.children {
                if matches!(child.try_wait(), Ok(None)) {
                    let _ = child.kill();
                }
                let _ = child.wait();
            }
            self.children.clear();
        }

        #[cfg(target_os = "windows")]
        {
            for child in &mut self.children {
                let _ = child.kill();
                let _ = child.wait();
            }
            self.children.clear();
            win_job::terminate_and_close_job(self.job_handle);
            self.job_handle = core::ptr::null_mut();
        }
    }

    pub fn active_count(&mut self) -> usize {
        self.children
            .iter_mut()
            .filter(|c| matches!(c.try_wait(), Ok(None)))
            .count()
    }
}

impl Drop for ManagedProcessGroup {
    fn drop(&mut self) {
        self.terminate_all();
    }
}

/// Validates and builds the exact CLI arguments for stock `llama-server` v1.0.0,
/// including `--rpc` and optional proportional `--tensor-split` weights across mixed-OS nodes.
pub fn build_llama_server_v1_args(
    model_path: &str,
    host: &str,
    port: u16,
    rpc_endpoints: &[String],
    threads: usize,
    ctx_size: usize,
) -> Vec<String> {
    build_llama_server_v1_args_with_split(
        model_path,
        host,
        port,
        rpc_endpoints,
        &[],
        threads,
        ctx_size,
    )
}

pub fn build_llama_server_v1_args_with_split(
    model_path: &str,
    host: &str,
    port: u16,
    rpc_endpoints: &[String],
    tensor_split_weights: &[u32],
    threads: usize,
    ctx_size: usize,
) -> Vec<String> {
    build_llama_server_v1_args_for_profile(
        model_path,
        host,
        port,
        rpc_endpoints,
        tensor_split_weights,
        threads,
        ctx_size,
        false,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn build_llama_server_v1_args_for_profile(
    model_path: &str,
    host: &str,
    port: u16,
    rpc_endpoints: &[String],
    tensor_split_weights: &[u32],
    threads: usize,
    ctx_size: usize,
    legacy_graphics: bool,
) -> Vec<String> {
    let ngl = if legacy_graphics { "0" } else { "99" };
    let mut args = vec![
        "-m".to_string(),
        model_path.to_string(),
        "--host".to_string(),
        host.to_string(),
        "--port".to_string(),
        port.to_string(),
        "-t".to_string(),
        threads.max(1).to_string(),
        "-c".to_string(),
        ctx_size.max(512).to_string(),
        "-ngl".to_string(),
        ngl.to_string(),
    ];
    if !rpc_endpoints.is_empty() {
        args.push("--rpc".to_string());
        args.push(rpc_endpoints.join(","));
        if !tensor_split_weights.is_empty() {
            let split_csv: Vec<String> = tensor_split_weights
                .iter()
                .map(|w| (*w).max(1).to_string())
                .collect();
            args.push("--tensor-split".to_string());
            args.push(split_csv.join(","));
        }
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_llama_server_v1_cli_flags_and_tensor_split() {
        let endpoints = vec![
            "127.0.0.1:50051".to_string(),
            "192.168.1.45:50052".to_string(),
        ];
        let args = build_llama_server_v1_args_with_split(
            "models/TinyStories-15M-Q4_K_M.gguf",
            "0.0.0.0",
            8081,
            &endpoints,
            &[8, 6, 10],
            4,
            2048,
        );
        assert!(args.contains(&"--rpc".to_string()));
        assert!(args.contains(&"127.0.0.1:50051,192.168.1.45:50052".to_string()));
        assert!(args.contains(&"--tensor-split".to_string()));
        assert!(args.contains(&"8,6,10".to_string()));
        assert!(args.contains(&"-ngl".to_string()));
    }

    #[test]
    fn test_legacy_graphics_forces_ngl_zero() {
        let args = build_llama_server_v1_args_for_profile(
            "models/tiny.gguf",
            "127.0.0.1",
            8081,
            &[],
            &[],
            2,
            1024,
            true,
        );
        let ngl_idx = args.iter().position(|a| a == "-ngl").expect("-ngl flag");
        assert_eq!(args[ngl_idx + 1], "0");
    }

    #[test]
    fn test_managed_process_group_cleanup() {
        let mut group = ManagedProcessGroup::new().expect("create process supervisor");
        assert_eq!(group.active_count(), 0);
        group.terminate_all();
    }
}
