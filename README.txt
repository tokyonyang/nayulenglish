hohobook OAuth branding fix

Files:
- app/page.jsx
- app/layout.jsx
- app/manifest.js
- app/privacy/page.jsx

Purpose:
- Make the public homepage visibly identify the app as "hohobook"
- Add a public privacy policy at /privacy
- Align page metadata/PWA app name with the OAuth consent-screen app name
- Explain Google Drive drive.file usage and data handling

After applying:
1. Deploy to Vercel.
2. Confirm https://hohobook.vercel.app shows "hohobook" without login.
3. Confirm https://hohobook.vercel.app/privacy is publicly accessible.
4. In Google Auth Platform > Branding, use:
   Home page: https://hohobook.vercel.app
   Privacy policy: https://hohobook.vercel.app/privacy
5. Complete website ownership verification if Google still requests it.
