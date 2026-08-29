# 小理控制台（Expo iOS）

这是 Android `android-control/` 的 Expo iOS 对应版本。应用只加载已配置 Bridge 的
`/mobile/` 页面，并阻止 HTTP、跨域、文件和自定义协议跳转。

## 本地检查

需要 Node.js 22.13 或更高版本。

```bash
npm install
npm run check
npm run export:ios
```

## 运行与构建

```bash
npm start
npx eas-cli build --platform ios --profile preview
```

`preview` 生成可安装到已登记 iPhone 的 Ad Hoc IPA；`production` 用于 TestFlight / App Store。
首次签名需要具有 Apple Developer 权限的账号，并为 `cn.xiaoli.control` 创建 App ID 与描述文件。

默认 Bridge：`https://xiaoli.136-110-78-96.sslip.io`

## 安全行为

- Bridge 地址保存在 iOS Keychain（Expo SecureStore）。
- WebView 仅允许当前 HTTPS scheme、host 与端口完全一致的导航。
- 管理员令牌仍由现有网页保存在该站点的 localStorage 中。
- “清除配置与本机数据”会清理 WebKit/系统 Cookie、网页存储、缓存和 Keychain 中的 Bridge 地址。
- iOS 版隐藏并阻止 Android APK 下载入口。
