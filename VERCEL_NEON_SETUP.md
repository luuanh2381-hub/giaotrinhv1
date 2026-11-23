# Hướng dẫn triển khai Admin Analytics & Chặn IP (Neon Singapore + Vercel Edge Config)

Dự án giữ nguyên 100% nội dung giáo trình HSK1–HSK4 dạng tĩnh để tải cực nhanh, đồng thời sử dụng:
- **Neon PostgreSQL (AWS Asia Pacific 1 – Singapore `ap-southeast-1`)**: Lưu toàn bộ thống kê Admin, nhật ký đăng nhập (IP/thiết bị), tổng hợp IP truy cập và danh sách chặn IP.
- **Vercel Serverless Functions (region `sin1` – Singapore)**: Lớp API `/api/*` giao tiếp với Neon cùng vùng địa lý (~5–10ms).
- **Vercel Edge Config + Edge Middleware (`middleware.js`)**: Chặn IP toàn web HSK ở tầng Edge trong ~1ms mà **không đánh thức Neon** khi học viên vào web.

---

## Bước 1: Tạo bảng trên Neon (AWS Asia Pacific 1 - Singapore)

1. Vào [Neon Console](https://console.neon.tech/) → tạo project chọn region **AWS Asia Pacific 1 (Singapore)**.
2. Mở mục **SQL Editor** trên Neon.
3. Copy toàn bộ nội dung file `sql/schema.sql` trong repo và bấm **Run**.
4. Vào **Dashboard → Connection Details**, bật **Connection pooling** và copy chuỗi `DATABASE_URL` (có dạng `postgresql://...@ep-...-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`).

---

## Bước 2: Deploy dự án lên Vercel & tạo Global Config

1. Đẩy mã nguồn lên GitHub và Import dự án vào **Vercel** (Framework Preset: `Other`, không cần Build Command).
2. Trong Dashboard dự án Vercel, vào tab **Storage → Browse Storage → Global Config** *(Ultra-low latency reads — tên mới của Edge Config, miễn phí)*.
3. Đặt tên (ví dụ `hsk-ip-blocks`) và **Connect** vào dự án Vercel của bạn.
   - Vercel sẽ tự động tạo biến môi trường `GLOBAL_CONFIG` cho dự án (code đã hỗ trợ cả `GLOBAL_CONFIG` mới lẫn `EDGE_CONFIG` cũ).
4. Vào **Vercel Account Settings → Tokens** → tạo một API Token mới (copy lại làm `VERCEL_API_TOKEN`) để Admin Dashboard tự động đồng bộ danh sách IP bị chặn từ Neon sang Global Config mỗi khi bạn bấm **Chặn / Gỡ chặn**.

---

## Bước 3: Cấu hình Environment Variables trên Vercel

Vào **Project Settings → Environment Variables** trên Vercel và thêm các biến sau:

| Biến môi trường | Bắt buộc | Giá trị / Ghi chú |
| :--- | :---: | :--- |
| `DATABASE_URL` | Có | Chuỗi Pooled Connection String từ Neon Singapore |
| `ADMIN_JWT_SECRET` | Có | Chuỗi ngẫu nhiên bảo mật ≥ 32 ký tự (dùng ký HttpOnly Cookie) |
| `ADMIN_DEFAULT_USER` | Có (lần đầu) | Tài khoản Admin khởi tạo (mặc định `admin`) |
| `ADMIN_DEFAULT_PASSWORD` | Có (lần đầu) | Mật khẩu Admin khởi tạo (hệ thống tự hash `bcrypt` vào Neon ở lần đăng nhập đầu tiên) |
| `GLOBAL_CONFIG` | Có | Tự động có sau Bước 2 khi Connect **Global Config** (hệ thống cũng tự tương thích `EDGE_CONFIG`) |
| `VERCEL_API_TOKEN` | Có | Token tạo ở Bước 2 để đồng bộ IP chặn sang Global Config |
| `VERCEL_TEAM_ID` | Nếu dùng Team | Chỉ cần điền nếu Global Config nằm trong Vercel Team (`team_...`) |
| `ADMIN_WHITELIST_IPS` | Khuyên dùng | Danh sách IP an toàn cách nhau bởi dấu phẩy (không bao giờ bị chặn, ví dụ IP nhà/văn phòng bạn) |

> Sau khi thêm biến môi trường, bấm **Redeploy** trên Vercel để áp dụng.

---

## Bước 4: Kiểm tra hoạt động

1. Mở trang chủ web HSK trên domain Vercel → bấm **Đăng nhập Admin**.
2. Đăng nhập bằng `ADMIN_DEFAULT_USER` / `ADMIN_DEFAULT_PASSWORD`.
   - Lần đăng nhập đầu tiên sẽ tự tạo tài khoản băm `bcrypt` trong bảng `admin_users` trên Neon.
   - Nên vào tab **Đăng nhập & Hệ thống → Đổi mật khẩu Admin** (sau đó bạn có thể xóa biến `ADMIN_DEFAULT_PASSWORD` khỏi Vercel).
3. Kiểm tra tab **IP & Chặn truy cập**:
   - Xác nhận dòng trạng thái hiển thị màu xanh: **"Vercel Edge Config đã kết nối"**.
   - Nếu cần, bấm **Đồng bộ lại Edge Config** để kiểm tra kết nối ghi.
   - Thử nhập một IP test (ví dụ `203.0.113.10`) để kiểm tra quy trình chặn & gỡ chặn (hệ thống tự khóa chức năng chặn với chính IP hiện tại của bạn để tránh tự khóa mình).

---

## Cơ chế bảo mật đã tích hợp sẵn
- **Không lộ mật khẩu ở frontend:** Xác thực bằng `bcrypt` trên Neon + `HttpOnly Secure JWT Cookie`.
- **Auto-ban chống dò mật khẩu:** Nhập sai mật khẩu Admin **5 lần trong 10 phút** sẽ tự động khóa IP đó **30 phút** trên toàn web và đồng bộ ngay lên Edge Config.
- **Chặn cả IP lẻ lẫn dải mạng CIDR:** Hỗ trợ IPv4 (`113.161.10.5` hoặc `113.161.10.0/24`) và IPv6.
- **Tiết kiệm Neon Compute Hours:** Học viên vào học chỉ đọc Edge Config (~1ms), sự kiện thống kê được gom thành lô (batch) mỗi 35 giây hoặc khi đóng tab bằng `navigator.sendBeacon`.
