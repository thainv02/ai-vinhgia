//! Server Node (sidecar): node.exe server/server.mjs --desktop chạy trong thư mục runtime/ cài kèm app.
//! Giao diện là trang planner ở 127.0.0.1:<ui_port>; API nội bộ ở 127.0.0.1:<api_port> (worker nhúng dùng).

use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

pub const PREFERRED_API_PORT: u16 = 8787;
pub const PREFERRED_UI_PORT: u16 = 8790;
const READY_TIMEOUT: Duration = Duration::from_secs(90);
const STOP_GRACE: Duration = Duration::from_secs(5);

/// Biến cấu hình server/worker đọc từ môi trường. Không cho kế thừa từ môi trường của máy: tên chung như ROOT_DIR, PORT
/// (VS Code, công cụ khác hay đặt) sẽ đè config.env và đưa DB/video ra chỗ khác. Cấu hình chỉ lấy từ <data>/config.env.
const SERVER_ENV_KEYS: &[&str] = &[
    "AI_API_KEY", "AI_API_URL", "AI_HOME", "AI_MODEL", "APP_DIR", "BROWSER_CDP_PORT", "BROWSER_CDP_URL", "CHROME_BIN",
    "CLIP_CAPTION_FONT", "CLIP_FFMPEG_PATH", "CLIP_FONTS_DIR", "CLIP_MIN_FREE_GB", "CLIP_SOURCE_MAX_BYTES", "CLIP_SOURCE_MAX_S",
    "CLIPROXY_BIN", "DATA_DIR", "DB_PATH", "DEBUG_ERRORS", "EMBEDDED_WORKER", "EXTRA_ALLOWED_ORIGINS", "FFMPEG_PATH",
    "FFPROBE_PATH", "GWR_BROWSER_PATH", "GWR_CLI", "GWR_TIMEOUT_MS", "GWR_VIDEO_BITRATE_MBPS", "HEARTBEAT_STALE_MINUTES",
    "LAN_ACCESS_CODE", "LAN_ALLOWED_HOSTS", "LAN_CLIP_SOURCE_MAX_BYTES", "LAN_CLIP_SOURCE_MAX_S",
    "LAN_CLIP_SOURCE_RETENTION_DAYS", "LAN_ENABLED", "LAN_HOST", "LAN_PORT", "LAN_REQUIRE_CODE", "LOG_LEVEL",
    "MANAGED_JOB_TYPES", "MAX_CONCURRENT_VIDEO_JOBS", "NODE_ENV", "NODE_OPTIONS", "PORT", "RENDER_CONCURRENCY",
    "REQUIRE_PROMPT_APPROVAL", "ROOT_DIR", "STT_MAX_RETRIES", "STT_MODELS_DIR", "STT_PROVIDER", "STT_TENANT_ID", "STT_THREADS",
    "STT_TIMEOUT_MS", "STT_URL",
    "TRASH_RETENTION_DAYS", "WATERMARK_REMOVER", "WORKER_MODE", "WORKER_ONLINE_SECONDS", "WORKER_TOKEN", "WORKER_TYPES",
];

fn is_server_env_key(key: &str) -> bool {
    let k = key.to_ascii_uppercase();
    k.starts_with("AUTOVIDEO_") || SERVER_ENV_KEYS.contains(&k.as_str())
}

pub struct Sidecar {
    child: Child,
    /// Giữ pipe stdin mở; đóng pipe (drop) là tín hiệu để server tắt gọn (--exit-on-stdin-close).
    stdin: Option<ChildStdin>,
    pub ui_port: u16,
}

/// Cổng trống trên 127.0.0.1: ưu tiên `preferred` (giữ origin cố định cho localStorage), bận thì để hệ điều hành chọn.
pub fn pick_port(preferred: u16, avoid: u16) -> u16 {
    if preferred != avoid && TcpListener::bind(("127.0.0.1", preferred)).is_ok() {
        return preferred;
    }
    loop {
        if let Ok(port) = TcpListener::bind(("127.0.0.1", 0)).and_then(|l| l.local_addr()).map(|a| a.port()) {
            if port != avoid {
                return port;
            }
        }
    }
}

pub fn log_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("logs")
}

impl Sidecar {
    /// `models_dir`: model nhận dạng lời nói do bộ cài chép sẵn (`%LOCALAPPDATA%\vn.syntra.autovideo\models`, xem installer/autovideo.iss).
    pub fn spawn(runtime_dir: &Path, data_dir: &Path, models_dir: &Path) -> Result<Sidecar, String> {
        let node = runtime_dir.join("node.exe");
        let server = runtime_dir.join("server").join("server.mjs");
        for f in [&node, &server] {
            if !f.is_file() {
                return Err(format!("Thiếu file của app: {}\nHãy cài lại AI Vinh Gia.", f.display()));
            }
        }
        fs::create_dir_all(log_dir(data_dir)).map_err(|e| format!("Không tạo được thư mục dữ liệu {}: {e}", data_dir.display()))?;
        // server production ghi log vào logs/server.log; stderr chỉ có lỗi trước khi logger chạy (vd không nạp được module)
        let stderr = File::create(log_dir(data_dir).join("sidecar-stderr.log")).map_err(|e| e.to_string())?;

        let api_port = pick_port(PREFERRED_API_PORT, 0);
        let ui_port = pick_port(PREFERRED_UI_PORT, api_port);

        let mut cmd = Command::new(&node);
        cmd.arg("--max-old-space-size=192")
            .arg(&server)
            .arg("--desktop")
            .arg("--exit-on-stdin-close")
            .arg("--app-dir")
            .arg(runtime_dir)
            .arg("--data-dir")
            .arg(data_dir)
            .arg("--port")
            .arg(api_port.to_string())
            .arg("--lan-port")
            .arg(ui_port.to_string())
            .arg("--stt-models-dir")
            .arg(models_dir)
            .current_dir(data_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::from(stderr));
        for (key, _) in std::env::vars_os() {
            if key.to_str().is_some_and(is_server_env_key) {
                cmd.env_remove(&key);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| format!("Không chạy được {}: {e}", node.display()))?;
        let stdin = child.stdin.take();
        Ok(Sidecar { child, stdin, ui_port })
    }

    pub fn ui_url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.ui_port)
    }

    /// Server đã thoát (lỗi khởi động)? Trả về mã thoát.
    pub fn exited(&mut self) -> Option<String> {
        match self.child.try_wait() {
            Ok(Some(status)) => Some(status.to_string()),
            Ok(None) => None,
            Err(e) => Some(e.to_string()),
        }
    }

    /// Tắt gọn: đóng stdin để server huỷ việc đang chạy và đóng DB; quá hạn thì kill.
    pub fn stop(mut self) {
        drop(self.stdin.take());
        let start = Instant::now();
        while start.elapsed() < STOP_GRACE {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// GET http://127.0.0.1:<port>/ trả 200 chưa (trang planner đã phục vụ được).
pub fn page_ready(port: u16) -> bool {
    let Ok(mut s) = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(500)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let req = format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 12];
    s.read_exact(&mut head).is_ok() && head.starts_with(b"HTTP/1.1 200")
}

/// Chờ server mở trang; lỗi kèm phần cuối log để người dùng/hỗ trợ biết nguyên nhân.
pub fn wait_ready(sidecar: &mut Sidecar, data_dir: &Path) -> Result<(), String> {
    let start = Instant::now();
    loop {
        if page_ready(sidecar.ui_port) {
            return Ok(());
        }
        if let Some(code) = sidecar.exited() {
            return Err(format!("Server dừng khi khởi động ({code}).\n\n{}", log_tail(data_dir)));
        }
        if start.elapsed() > READY_TIMEOUT {
            return Err(format!("Server không phản hồi sau {} giây.\n\n{}", READY_TIMEOUT.as_secs(), log_tail(data_dir)));
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

fn log_tail(data_dir: &Path) -> String {
    let dir = log_dir(data_dir);
    let mut out = format!("Thư mục log: {}", dir.display());
    for name in ["sidecar-stderr.log", "server.log"] {
        if let Ok(text) = fs::read_to_string(dir.join(name)) {
            let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
            if !lines.is_empty() {
                out.push_str(&format!("\n\n{name}:\n{}", lines[lines.len().saturating_sub(15)..].join("\n")));
            }
        }
    }
    out
}
