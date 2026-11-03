// Vỏ app desktop AutoVideo (giai đoạn 4 của PLAN-windows-exe.md): một cửa sổ WebView2 hiển thị trang planner
// do server Node (sidecar) phục vụ ở 127.0.0.1. Không có tray, không chạy nền: đóng cửa sổ là tắt hết.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod job;
mod settings;
mod sidecar;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use sidecar::Sidecar;
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

struct AppState {
    sidecar: Mutex<Option<Sidecar>>,
    data_dir: Mutex<Option<PathBuf>>,
    /// Cửa sổ đã đóng / app đang thoát: luồng khởi động không được spawn hay giữ server nữa.
    exiting: Mutex<bool>,
}

/// Thư mục runtime cài kèm (node.exe, server/, web/, bin/, tools/gwr). `AUTOVIDEO_RUNTIME_DIR` ghi đè khi chạy thử.
fn runtime_dir(app: &AppHandle) -> PathBuf {
    if let Some(dir) = std::env::var_os("AUTOVIDEO_RUNTIME_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    strip_verbatim(app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."))).join("runtime")
}

/// Model nhận dạng lời nói: `%LOCALAPPDATA%\vn.syntra.autovideo\models` — bộ cài chép sẵn vào đây (installer/autovideo.iss). Ngoài thư mục cài đặt nên
/// cập nhật app không mất model; gỡ app chỉ xoá khi người dùng chọn "Delete app data".
fn models_dir(app: &AppHandle) -> PathBuf {
    strip_verbatim(app.path().app_local_data_dir().unwrap_or_else(|_| PathBuf::from("."))).join("models")
}

/// resource_dir() trả về dạng `\\?\C:\...`; node.exe không nạp được script chính từ đường dẫn đó (EISDIR lstat 'C:').
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p,
    }
}

/// Mở thư mục / URL bằng chương trình mặc định của Windows (Explorer, trình duyệt).
fn shell_open(target: &str) {
    let _ = Command::new("explorer.exe").arg(target).spawn();
}

fn reveal_file(path: &Path) {
    let _ = Command::new("explorer.exe").arg(format!("/select,{}", path.display())).spawn();
}

fn show_error(window: &WebviewWindow, detail: &str) {
    let js = format!("window.__avError({})", serde_json::to_string(detail).unwrap_or_default());
    let _ = window.eval(js);
}

/// Chạy ngoài luồng chính: chọn thư mục dữ liệu (lần đầu), khởi động server, chờ sẵn sàng rồi chuyển cửa sổ sang trang planner.
fn start_backend(app: AppHandle, window: WebviewWindow) {
    let state = app.state::<AppState>();
    let data_dir = settings::resolve_data_dir(&app);
    *state.data_dir.lock().unwrap() = Some(data_dir.clone());

    let mut sc = match Sidecar::spawn(&runtime_dir(&app), &data_dir, &models_dir(&app)) {
        Ok(sc) => sc,
        Err(e) => return show_error(&window, &e),
    };
    let ready = sidecar::wait_ready(&mut sc, &data_dir);
    let url = sc.ui_url();
    {
        let mut slot = state.sidecar.lock().unwrap();
        if *state.exiting.lock().unwrap() {
            drop(slot);
            sc.stop();
            return;
        }
        *slot = Some(sc);
    }
    match ready {
        Ok(()) => {
            let _ = window.navigate(Url::parse(&url).unwrap());
        }
        Err(e) => show_error(&window, &e),
    }
}

fn stop_backend(app: &AppHandle) {
    let state = app.state::<AppState>();
    *state.exiting.lock().unwrap() = true;
    let sc = state.sidecar.lock().unwrap().take();
    if let Some(sc) = sc {
        sc.stop();
    }
}

fn open_data_subdir(app: &AppHandle, sub: Option<&str>) {
    let dir = app.state::<AppState>().data_dir.lock().unwrap().clone();
    if let Some(dir) = dir {
        let dir = sub.map(|s| dir.join(s)).unwrap_or(dir);
        let _ = std::fs::create_dir_all(&dir);
        shell_open(&dir.to_string_lossy());
    }
}

/// Link ra ngoài (ChatGPT, Google Flow) và mọi yêu cầu mở cửa sổ mới: mở bằng trình duyệt mặc định, không mở trong app.
fn is_app_url(url: &Url) -> bool {
    matches!(url.scheme(), "tauri" | "http" | "https")
        && matches!(url.host_str(), Some("127.0.0.1") | Some("tauri.localhost") | Some("localhost"))
}

fn build_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    // Không dùng thanh menu của cửa sổ (trùng tên app với thanh tiêu đề). Mở thư mục dữ liệu/log: link autovideo://open-data, autovideo://open-logs
    // trong giao diện (Cài đặt, thanh trạng thái, màn mất kết nối); tải lại trang: F5.
    let nav_app = app.clone();
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("AI Vinh Gia")
        // Gán logo cho cửa sổ đang chạy (taskbar / Alt+Tab), cùng bộ nhận diện với icon của file .exe.
        .icon(tauri::include_image!("icons/128x128.png"))?
        .inner_size(1440.0, 900.0)
        .min_inner_size(1024.0, 680.0)
        .center()
        .maximized(true)
        .on_navigation(move |url| {
            // Link nội bộ của giao diện (vd nút "Mở thư mục log" ở màn mất kết nối, lúc server không trả lời): app tự xử lý, không điều hướng.
            if url.scheme() == "autovideo" {
                match url.host_str() {
                    Some("open-logs") => open_data_subdir(&nav_app, Some("logs")),
                    Some("open-data") => open_data_subdir(&nav_app, None),
                    _ => {}
                }
                return false;
            }
            if is_app_url(url) {
                return true;
            }
            shell_open(url.as_str());
            false
        })
        .on_new_window(|url, _features| {
            shell_open(url.as_str());
            NewWindowResponse::Deny
        })
        // Tải file (video, ảnh): lưu vào thư mục Downloads như trình duyệt, xong thì mở Explorer chọn sẵn file
        .on_download(|_webview, event| {
            if let DownloadEvent::Finished { path: Some(path), success: true, .. } = event {
                reveal_file(&path);
            }
            true
        })
        .build()
}

fn main() {
    // Trước mọi spawn: tiến trình con sinh sau tự thuộc job (xem job.rs). Lỗi thì vẫn chạy, dựa vào tắt qua stdin.
    if let Err(e) = job::assign_self_to_kill_on_close_job() {
        eprintln!("Không gán được Job Object: {e}");
    }

    let app = tauri::Builder::default()
        // Mở lần 2: đưa cửa sổ đang có lên trước, không chạy server thứ hai
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState { sidecar: Mutex::new(None), data_dir: Mutex::new(None), exiting: Mutex::new(false) })
        .setup(|app| {
            let window = build_window(app.handle())?;
            let handle = app.handle().clone();
            std::thread::spawn(move || start_backend(handle, window));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("không khởi tạo được cửa sổ AI Vinh Gia");

    app.run(|app, event| {
        // Đóng cửa sổ cuối hoặc menu Thoát → ExitRequested. Tắt server ở đây rồi thoát luôn: chờ RunEvent::Exit thì có lúc
        // không tới (vòng lặp kẹt khi dọn WebView2), server không được tắt và AutoVideo.exe treo lại.
        if let RunEvent::ExitRequested { code, .. } = event {
            stop_backend(app);
            std::process::exit(code.unwrap_or(0));
        }
    });
}
