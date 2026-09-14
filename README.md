# Daricha (دریچه) — qr-mirror

اشتراک‌گذاری صفحه، چت متنی، ارسال فایل و پیام صوتی به‌صورت مستقیم
(peer-to-peer) روی WebRTC. یک بک‌اند سبک برای هویت نشست، چرخهٔ عمر واقعی
اتاق، محدودسازی نرخ، و صدور credential موقت TURN کنارش اضافه شده — اما
محتوای پیام/فایل هرگز از بک‌اند عبور نمی‌کند.

## ساختار پروژه

```
qr-mirror/
├── src/                  # فرانت‌اند (React + Vite + Tailwind)
│   ├── App.jsx
│   └── lib/
│       ├── api.js         # کلاینت بک‌اند (session/room/TURN)
│       ├── constants.js   # تمام حد و مرزهای امنیتی، یک‌جا
│       ├── id.js          # تولید شناسهٔ امن (crypto.getRandomValues)
│       ├── opfs.js        # نوشتن فایل دریافتی روی OPFS به‌جای RAM
│       └── validation.js  # اعتبارسنجی کامل پیام‌های ورودی از peer
├── public/
│   ├── _headers            # هدرهای امنیتی برای هاست استاتیک (Netlify)
│   └── manifest.webmanifest / icons / sw.js   # PWA
├── vercel.json              # همان هدرهای امنیتی، برای Vercel
├── .env.example              # متغیرهای محیطی فرانت‌اند
└── server/                  # بک‌اند (Node + Express)
    ├── src/
    │   ├── index.js          # اپ اکسپرس + هدرهای امنیتی (CSP/HSTS/...)
    │   ├── store.js          # چرخهٔ عمر اتاق‌ها (در حافظه)
    │   ├── peerServer.js      # PeerServer اختیاری خوداستقرار
    │   ├── middleware/rateLimit.js
    │   └── routes/{auth,rooms,turn}.js
    └── .env.example
```

## اجرا (فرانت‌اند + بک‌اند)

```bash
# 1) بک‌اند
cd server
npm install
cp .env.example .env    # SESSION_JWT_SECRET را حتماً عوض کن
npm run dev             # پیش‌فرض: http://localhost:8787

# 2) فرانت‌اند (در یک ترمینال دیگر، از ریشهٔ پروژه)
cp .env.example .env.local   # VITE_API_BASE_URL را به آدرس بک‌اند تنظیم کن
npm install
npm run dev              # http://localhost:5173
```

بدون اجرای بک‌اند هم برنامه بالا می‌آید — در «حالت محلی» (بدون
اعتبارسنجی سرور برای اتاق، بدون TURN اختصاصی)، دقیقاً مثل نسخهٔ قبلی. یک
بنر در بالای برنامه همیشه نشان می‌دهد در کدام حالت هستید.

## ساخت نسخهٔ نهایی (build)

```bash
npm run build && npm run preview
```

خروجی در `dist/` است. برای دیپلوی استاتیک (Vercel/Netlify/...) فایل‌های
`_headers` و `vercel.json` هدرهای امنیتی لازم را از قبل تنظیم کرده‌اند —
فقط `connect-src` را بعد از دیپلوی به آدرس واقعی بک‌اند/TURN/PeerServر
خودتان محدودتر کنید.

---

## ✅ چک‌لیست امنیتی (وضعیت واقعی — نه فقط ادعا)

این جدول دقیقاً مطابق ۲۰ موردی است که خواسته شد بررسی شود. هیچ موردی را
فقط با تغییر متن «Implemented» اعلام نکردم؛ جایی که کد واقعی پیاده نشده
یا قابل تست در این محیط نبوده، صادقانه ⚠️/❌ گذاشتم.

| # | مورد | وضعیت | توضیح |
|---|---|---|---|
| 1 | Backend + Authentication واقعی | ⚠️ Partial | `server/` نشست ناشناس کوتاه‌مدت (JWT) صادر می‌کند و مالکیت اتاق را باهاش پیگیری می‌کند. این «حساب کاربری» یا احراز هویت قوی نیست (چون معماری بدون‌سرور/P2P بودن حفظ شده) — یک لایهٔ session-scoping واقعی روی چرخهٔ اتاق است، نه بیشتر. |
| 2 | PeerJS Cloud وابستگی دائمی نباشد | ✅ Implemented | `VITE_PEER_SERVER_HOST/PORT/PATH/KEY/SECURE` + `server/src/peerServer.js` (اختیاری، `ENABLE_PEER_SERVER=true`). بدون تنظیم این‌ها، پیش‌فرض PeerJS Cloud است — دقیقاً طبق درخواست «باید بتوانیم» نه «باید حذف شود». |
| 3 | TURN اختصاصی با credential کوتاه‌مدت | ⚠️ Partial | `/api/turn` credential زمان‌دار (HMAC، منقضی بعد از `TURN_TTL_SECONDS`) صادر می‌کند — کد کامل و کار می‌کند. اما **راه‌اندازی خودِ سرور TURN (coturn) کاری زیرساختی است که در این محیط انجام نشد** — بدون یک TURN واقعی که `TURN_SECRET`/`TURN_URLS` را ست کنید، اندپوینت فقط STUN برمی‌گرداند. |
| 4 | Rate Limit درخواست اتصال | ✅ Implemented | `MAX_PENDING_REQUESTS=10`، رد درخواست تکراری از یک Peer، تایم‌اوت خودکار (`INCOMING_REQUEST_TIMEOUT_MS`)، و cooldown ۶۰ ثانیه‌ای بعد از ۲ بار رد شدن (`REJECT_COOLDOWN_MS` / `MAX_REJECTS_BEFORE_BLOCK`) — همه در `App.jsx`. |
| 5 | جلوگیری از RAM Exhaustion فایل | ✅ Implemented | `src/lib/opfs.js` — chunkهای دریافتی مستقیم روی OPFS نوشته می‌شوند، نه آرایهٔ RAM. در مرورگرهای بدون OPFS به‌صورت خودکار به آرایهٔ حافظه (همان سقف ۲۰۰MB) سقوط می‌کند تا کرش نکند، اما دیگر مزیت حافظه را ندارد. |
| 6 | اعتبارسنجی کامل File Transfer | ✅ Implemented | `src/lib/validation.js`: transferId/size/name/mime/kind روی `file-start`، نوع و اندازهٔ chunk روی `file-chunk`، و `received !== size` روی `file-end` باعث رد فایل می‌شود (چیزی ساخته/ذخیره نمی‌شود). |
| 7 | Transfer ID ضعیف (Math.random) | ✅ Implemented | `src/lib/id.js` → `generateSecureId` با `crypto.getRandomValues`، همه‌جا جایگزین `Math.random` شد. |
| 8 | محدودیت پیام متنی | ✅ Implemented | `MAX_MESSAGE_LENGTH = 10000` — هم ورودی هم خروجی چک می‌شود. |
| 9 | Voice Chat (زمان/حجم/integrity/cleanup) | ✅ Implemented | سقف ۵ دقیقه (`MAX_VOICE_DURATION_MS`) و ۲۵MB (`MAX_VOICE_SIZE`)، همان مسیر chunked+validated فایل معمولی (پس integrity/چک تعداد chunk هم شامل می‌شود)، و همهٔ Object URLها ردیابی و در logout/unmount با `URL.revokeObjectURL` آزاد می‌شوند. |
| 10 | Screen Sharing وابسته به وضعیت Session | ✅ Implemented | دکمهٔ اشتراک فقط وقتی `connectionStatus === "connected"` فعال است؛ وقتی peer قطع شود استریم محلی و ریموت هر دو `stop()` می‌شوند؛ دکمهٔ «قطع» همیشه در دسترس است. |
| 11 | Room Code واقعی (crypto + انقضا + یک‌بارمصرف سمت سرور) | ✅ Implemented | کد اتاق هم فرانت (`crypto.getRandomValues`) هم بک‌اند (`server/src/store.js`, `crypto.randomBytes`) رمزنگاری‌شده تولید می‌شود. وقتی بک‌اند در دسترس است، `expiresAt`/`used` واقعاً در `checkRoom`/`consumeRoom` روی سرور بررسی می‌شود — `setInterval` فرانت فقط چرخش UI را انجام می‌دهد، نه مرز امنیتی. بدون بک‌اند، به‌صورت شفاف («فقط محلی» در UI) به همان تایمر قبلی سقوط می‌کند. |
| 12 | One-Time Room | ✅ Implemented | `consumeRoom` روی سرور اتاق را `used=true` می‌کند؛ میزبان هم بلافاصله بعد از پذیرفتن یک اتصال از طریق اتاق، Peer اتاق را می‌چرخاند (`rotateRoomAfterUse`) تا حتی در سطح WebRTC هم دیگر قابل اتصال نباشد، نه فقط در دفترداری بک‌اند. |
| 13 | Connection State دقیق | ✅ Implemented | `idle / connecting / connected / reconnecting / disconnected / rejected / expired / failed` — هرکدام جدا نمایش داده می‌شوند. |
| 14 | Reconnect محدود و منطقی | ✅ Implemented | حداکثر ۳ تلاش با backoff نمایی؛ بعد از قطع دستی (logout/Stop) کاملاً متوقف می‌شود (`manualCloseRef`)؛ برای اتصال‌های مبتنی بر اتاق، بعد از اتمام تلاش‌ها وضعیت «expired» نشان داده می‌شود نه تلاش بی‌پایان. |
| 15 | Peer Registration بدون fallback جعلی | ✅ Implemented | ثبت‌نام فقط با رویداد واقعی `peer.on("open")` نهایی می‌شود. حالت آفلاین دیگر «موفقیت جعلی» نیست — مستقیماً خطا نشان می‌دهد. خطای شبکه به‌صورت پیام در UI نمایش داده می‌شود. |
| 16 | Cleanup کامل | ✅ Implemented | یک تابع واحد (`performFullCleanup`) در logout و در unmount کامپوننت: peer/room-peer/conn بسته می‌شوند، track های media متوقف، Object URLها آزاد، تایمرها پاک، صف درخواست‌ها و transferهای ناقص پاک می‌شوند. |
| 17 | Input Security (بدون innerHTML) | ✅ Implemented | تمام متن دریافتی از peer فقط از طریق رندر معمولی React (`{message.text}`) نمایش داده می‌شود — هیچ‌جای کد از `dangerouslySetInnerHTML` استفاده نشده. |
| 18 | CSP و Security Headers | ✅ Implemented | `server/src/index.js` (helmet: CSP بدون `unsafe-eval`/`unsafe-inline` در script-src، HSTS، Referrer-Policy، Permissions-Policy) برای بک‌اند؛ `public/_headers` و `vercel.json` همان هدرها را برای هاست استاتیک فرانت‌اند فراهم می‌کنند. |
| 19 | HTTPS در Production | ⚠️ Partial | کد/کانفیگ آماده است (HSTS ست می‌شود، secure cookie لازم نیست چون کوکی‌ای در کار نیست) اما **واقعاً دیپلوی روی HTTPS و تست عملی WebRTC/میکروفون/دوربین روی آن در این محیط ممکن نبود** — این یک تصمیم زیرساخت/دیپلوی است، نه چیزی که از کد به‌تنهایی تضمین شود. |
| 20 | Secrets خارج از Frontend | ✅ Implemented | `SESSION_JWT_SECRET` و `TURN_SECRET` فقط در `server/.env` هستند. فرانت‌اند فقط توکن نشست کوتاه‌مدت (در حافظه، نه `localStorage`) و credential کوتاه‌مدت TURN را می‌گیرد — هیچ secret دائمی در `App.jsx`/بسته build/`localStorage` ذخیره نمی‌شود. |

### دربارهٔ ۲۰ سناریوی تست خواسته‌شده

**صادقانه: هیچ‌کدام از ۲۰ سناریو در این محیط اجرا نشدند.** این sandbox
شبکهٔ خروجی ندارد و به یک دستگاه دوم/شبکهٔ واقعی دسترسی ندارم — یعنی نه
اتصال دو دستگاه واقعی، نه NAT سخت، نه قطع‌شدن واقعی PeerServer/TURN وسط
کار قابل شبیه‌سازی بود. کدی که نوشتم از نظر منطقی این سناریوها را پوشش
می‌دهد (مثلاً: عدم تطابق `received !== size` رد می‌شود، صف درخواست سقف
دارد، reconnect محدود است) و از نظر نحوی/type بررسی شده، اما **بدون اجرای
واقعی این ۲۰ مورد روی حداقل دو دستگاه، نمی‌توانم بگویم «تضمین‌شده کار
می‌کند»**. لطفاً قبل از استفادهٔ واقعی، خودتان این سناریوها را (حداقل
موارد بحرانی: فایل ۲۰۰MB+، قطع وسط انتقال، ۲۰ درخواست پشت‌سرهم، NAT سخت)
تست کنید — دقیقاً همان چیزی که «قانون مهم» در درخواست‌تان می‌خواست: من
هیچ‌چیزی را «تست شد» اعلام نمی‌کنم مگر واقعاً تست شده باشد.

---

## 📄 فایل‌های تغییریافته/اضافه‌شده در این دور و دلیل هرکدام

**جدید — بک‌اند:**
- `server/src/index.js` — اپ اکسپرس + هدرهای امنیتی
- `server/src/config.js` — خواندن متغیرهای محیطی، بدون secret هاردکد
- `server/src/store.js` — چرخهٔ عمر اتاق (ایجاد/بررسی/مصرف/انقضا) در حافظه
- `server/src/routes/auth.js` — صدور و بررسی نشست ناشناس کوتاه‌مدت
- `server/src/routes/rooms.js` — API چرخهٔ عمر اتاق
- `server/src/routes/turn.js` — صدور credential موقت TURN
- `server/src/middleware/rateLimit.js` — محدودسازی نرخ HTTP
- `server/src/peerServer.js` — PeerServer اختیاری خوداستقرار
- `server/package.json`, `server/.env.example`, `server/README.md`

**جدید — فرانت‌اند:**
- `src/lib/constants.js` — تمام حد و مرزهای امنیتی در یک فایل
- `src/lib/id.js` — تولید شناسهٔ امن (`crypto.getRandomValues`)
- `src/lib/validation.js` — اعتبارسنجی کامل پیام پروتکل فایل
- `src/lib/opfs.js` — نوشتن فایل دریافتی روی OPFS
- `src/lib/api.js` — کلاینت بک‌اند
- `.env.example`, `public/_headers`, `vercel.json`

**بازنویسی‌شده:**
- `src/App.jsx` — یکپارچه‌سازی کامل با بک‌اند (نشست/اتاق/TURN)، صف
  درخواست با rate-limit، انتقال فایل/صدا با اعتبارسنجی کامل + OPFS،
  وضعیت‌های اتصال دقیق‌تر (rejected/expired/failed)، ثبت‌نام بدون
  fallback جعلی، و cleanup کامل در logout/unmount.
- `README.md` (همین فایل)

**بدون تغییر:** `src/main.jsx`, `src/index.css`, `index.html`,
`tailwind.config.js`, `postcss.config.js`, `public/manifest.webmanifest`,
`public/sw.js`, `public/icons/*`

## چگونه کار می‌کند؟

- هر کاربر یک آیدی دائمی PeerJS دارد (`daricha-id-<username>`) که فقط در
  `localStorage` همان مرورگر ذخیره می‌شود؛ این آیدی هرگز به‌عنوان رمز یا
  توکن استفاده نمی‌شود.
- اتاق‌ها موجودیت جدا و موقتی هستند (`daricha-room-<code>`) — پیوندی به
  آیدی دائمی میزبان ندارند، پس لینک/QR دعوت هرگز هویت دائمی را فاش
  نمی‌کند.
- هر اتصال یا درخواست اشتراک صفحه باید توسط طرف مقابل دستی تأیید شود.
- فایل و صدا به‌صورت تکه‌ای (۱۶KB)، با اعتبارسنجی کامل هر پیام، و
  نوشته‌شده مستقیم روی دیسک (OPFS) منتقل می‌شوند — نه یک‌جا در RAM.
