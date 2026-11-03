# Thông báo bản quyền - html-runtime (Video HTML)

Thư mục này chứa các file do SERVER cung cấp cho mọi composition (AI không được tự viết): `gsap.min.js`, `runtime.js`, `fonts/*.woff2`.
Chúng được chép vào `__hf/` của thư mục làm việc/preview. Không tải từ CDN lúc chạy.

| File | Nguồn | Giấy phép |
|---|---|---|
| `gsap.min.js` | GSAP 3.15.0 (gói `hyperframes` dist/vendor/npm/gsap.min.js) | GreenSock "Standard License" https://gsap.com/standard-license - miễn phí kể cả thương mại, có điều khoản hạn chế (không dùng trong công cụ cho người dùng cuối tạo sản phẩm hoạt họa trực quan cạnh tranh với Webflow/GSAP). CẦN XEM XÉT PHÁP LÝ trước khi phát hành. |
| `runtime.js` | `@hyperframes/core@0.8.221` dist/hyperframe.runtime.iife.js (sao chép nguyên văn) | Apache-2.0 (HeyGen, https://github.com/heygen-com/hyperframes) |
| `fonts/be-vietnam-pro-*.woff2` | `@fontsource/be-vietnam-pro` (latin, latin-ext, vietnamese; 400/600/700/800) | SIL Open Font License 1.1 - xem `fonts/OFL.txt` |

Thành phần khác dùng khi dựng video (không nằm trong thư mục này):
- `@hyperframes/producer`, `@hyperframes/lint`, `@hyperframes/core`, `@hyperframes/engine`, `@hyperframes/parsers`, `@hyperframes/studio-server` 0.8.221 - Apache-2.0 (kèm LICENSE trong node_modules được đóng gói).
- `@hyperframes/player` 0.8.221 (giao diện xem trước) - file LICENSE trong gói là Apache-2.0 (README ghi MIT: cần đối chiếu).
- `puppeteer`, `puppeteer-core` - Apache-2.0.
- chrome-headless-shell 152.0.7977.30 (Chrome for Testing) - tải riêng khi người dùng bấm "Tải bộ dựng"; kèm LICENSE.headless_shell và thông báo bên thứ ba của Chromium trong gói tải về.
- ffmpeg - xem `bin/ffmpeg-LICENSE.txt` của bản cài.

Cập nhật: khi nâng `@hyperframes/*`, chép lại `runtime.js` từ cùng phiên bản và đối chiếu diff trước khi phát hành.
