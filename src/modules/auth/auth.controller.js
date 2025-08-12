// modules/auth/auth.controller.js
import AuthService from './auth.service.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';

class AuthController {
  register = asyncHandler(async (req, res) => {
    const userData = req.body;
    const result = await AuthService.register(userData);
    
    res.status(201).json({
      success: true,
      message: 'Registration successful',
      data: result
    });
  });

  login = asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const result = await AuthService.login(email, password);
    
    // Set refresh token as httpOnly cookie
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    });
    
    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: result.user,
        accessToken: result.accessToken
      }
    });
  });

  refreshToken = asyncHandler(async (req, res) => {
    const { refreshToken } = req.cookies;
    const result = await AuthService.refreshToken(refreshToken);
    
    res.json({
      success: true,
      data: { accessToken: result.accessToken }
    });
  });

  logout = asyncHandler(async (req, res) => {
    res.clearCookie('refreshToken');
    
    res.json({
      success: true,
      message: 'Logout successful'
    });
  });

  forgotPassword = asyncHandler(async (req, res) => {
    const { email } = req.body;
    await AuthService.forgotPassword(email);
    
    res.json({
      success: true,
      message: 'Password reset email sent'
    });
  });

  resetPassword = asyncHandler(async (req, res) => {
    const { token } = req.params;
    const { password } = req.body;
    
    await AuthService.resetPassword(token, password);
    
    res.json({
      success: true,
      message: 'Password reset successful'
    });
  });

  verifyEmail = asyncHandler(async (req, res) => {
    const { token } = req.params;
    await AuthService.verifyEmail(token);
    
    res.json({
      success: true,
      message: 'Email verified successfully'
    });
  });
}

export default new AuthController();