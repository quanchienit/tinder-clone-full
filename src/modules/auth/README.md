📋 AUTH ROUTES STRUCTURE:
Public Routes (No Authentication Required):

POST /api/auth/register - Đăng ký với rate limiting
POST /api/auth/login - Đăng nhập với auth limiter
POST /api/auth/2fa/verify - Xác thực 2FA
POST /api/auth/refresh - Refresh token
GET /api/auth/verify-email/:token - Verify email
POST /api/auth/password/forgot - Quên mật khẩu
POST /api/auth/password/reset/:token - Reset mật khẩu
POST /api/auth/account/recover - Khôi phục tài khoản
GET /api/auth/check-email - Check email availability
GET /api/auth/check-phone - Check phone availability
POST /api/auth/password/strength - Check password strength

OAuth Routes:

GET /api/auth/google - Google OAuth initiation
GET /api/auth/google/callback - Google callback
GET /api/auth/facebook - Facebook OAuth initiation
GET /api/auth/facebook/callback - Facebook callback
POST /api/auth/apple - Apple Sign In
POST /api/auth/apple/callback - Apple callback

Protected Routes (Authentication Required):

POST /api/auth/logout - Đăng xuất
GET /api/auth/status - Trạng thái auth (optional auth)
POST /api/auth/validate - Validate token
POST /api/auth/verify-email/send - Gửi email verification
POST /api/auth/verify-phone/send - Gửi SMS OTP
POST /api/auth/verify-phone - Verify phone với OTP
POST /api/auth/password/change - Đổi mật khẩu
POST /api/auth/resend-verification - Gửi lại verification

Session Management:

GET /api/auth/sessions - Lấy danh sách sessions
DELETE /api/auth/sessions/:sessionId - Thu hồi session

Two-Factor Authentication:

POST /api/auth/2fa/enable - Bật 2FA
POST /api/auth/2fa/verify-setup - Verify 2FA setup
POST /api/auth/2fa/disable - Tắt 2FA
POST /api/auth/2fa/backup-codes - Tạo lại backup codes
POST /api/auth/2fa/send - Gửi 2FA code

OAuth Account Management:

POST /api/auth/oauth/:provider/link - Link OAuth account
DELETE /api/auth/oauth/:provider - Unlink OAuth account

Account Management:

DELETE /api/auth/account - Xóa tài khoản
GET /api/auth/security - Security settings

Admin Routes:

POST /api/auth/admin/impersonate - Impersonate user (disabled)
POST /api/auth/admin/unlock-account - Unlock account

Utility:

GET /api/auth/health - Health check