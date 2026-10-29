// Điểm vào chạy production (npm start, bản build): đặt NODE_ENV trong code để không phụ thuộc cú pháp của shell.
process.env.NODE_ENV ??= 'production';
await import('./index.js');
