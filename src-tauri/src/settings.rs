//! Thư mục dữ liệu (config.env, data/app.db, output/, refs/, logs/): người dùng chọn ở lần chạy đầu,
//! lưu vào %APPDATA%\AutoVideo\settings.json (giữ đường dẫn cũ sau khi đổi tên thành AI Vinh Gia).
//! `AUTOVIDEO_DATA_DIR` ghi đè (chạy thử, không hỏi).

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Settings {
    data_dir: Option<PathBuf>,
}

fn settings_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().config_dir().ok().map(|d| d.join("AutoVideo").join("settings.json"))
}

/// Mặc định: D:\AutoVideo nếu máy có ổ D, ngược lại %USERPROFILE%\AutoVideo.
fn default_data_dir(app: &AppHandle) -> PathBuf {
    if Path::new("D:\\").is_dir() {
        return PathBuf::from("D:\\AutoVideo");
    }
    app.path().home_dir().unwrap_or_else(|_| PathBuf::from(".")).join("AutoVideo")
}

/// Thư mục dữ liệu đã lưu; chưa có thì hỏi người dùng (chạy ngoài luồng chính vì hộp thoại là blocking).
pub fn resolve_data_dir(app: &AppHandle) -> PathBuf {
    if let Some(dir) = std::env::var_os("AUTOVIDEO_DATA_DIR").filter(|v| !v.is_empty()) {
        return PathBuf::from(dir);
    }
    let file = settings_file(app);
    if let Some(saved) = file
        .as_ref()
        .and_then(|f| fs::read_to_string(f).ok())
        .and_then(|t| serde_json::from_str::<Settings>(&t).ok())
        .and_then(|s| s.data_dir)
    {
        return saved;
    }

    let default = default_data_dir(app);
    // true = nút OK ("Dùng mặc định")
    let use_default = app
        .dialog()
        .message(format!(
            "AI Vinh Gia lưu dự án, video và cấu hình trong một thư mục dữ liệu.\n\nDùng thư mục mặc định:\n{}\n\nhay chọn thư mục khác?",
            default.display()
        ))
        .title("Chọn thư mục dữ liệu")
        .buttons(MessageDialogButtons::OkCancelCustom("Dùng mặc định".into(), "Chọn thư mục khác…".into()))
        .blocking_show();
    let chosen = if use_default {
        default.clone()
    } else {
        app.dialog()
            .file()
            .set_title("Chọn thư mục dữ liệu của AI Vinh Gia")
            .blocking_pick_folder()
            .and_then(|p| p.into_path().ok())
            .unwrap_or(default)
    };

    if let Some(f) = file {
        let _ = fs::create_dir_all(f.parent().unwrap());
        let body = serde_json::to_string_pretty(&Settings { data_dir: Some(chosen.clone()) }).unwrap();
        let _ = fs::write(f, body);
    }
    chosen
}
