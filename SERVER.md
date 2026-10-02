# راه‌اندازی سرور پیام‌رسان

پوشه‌ی `server/` سرور کامل است (اتاق رمزدار، چت لحظه‌ای، جستجوی فارسی/انگلیسی) و صفحه‌ی چت (`server/public/index.html`) را هم خودش به اپ می‌دهد. پوسته‌ی اندروید (Capacitor) بدون تغییر مانده است.

## روی VPS (اوبونتو)
1. دامنه را به IP سرور وصل کن (رکورد A).
2. نصب Node.js 20+ و Caddy:
   `sudo apt install -y nodejs npm caddy build-essential python3`
3. پوشه‌ی `server` را روی سرور کپی کن و داخلش اجرا کن:
   `npm install && node server.js`
4. فایل `server/Caddyfile` را (با دامنه‌ی خودت) به `/etc/caddy/Caddyfile` ببر و `sudo systemctl reload caddy` بزن.
5. در `capacitor.config.json` مقدار `https://YOURDOMAIN.com` را با همان دامنه عوض کن و APK را مثل قبل با GitHub Actions بساز.

## همیشه روشن ماندن (systemd)
فایل `/etc/systemd/system/payamresan.service`:

    [Service]
    WorkingDirectory=/opt/payamresan/server
    ExecStart=/usr/bin/node server.js
    Restart=always
    Environment=PORT=3000 KEEP_DAYS=30

    [Install]
    WantedBy=multi-user.target

سپس: `sudo systemctl enable --now payamresan`

## تنظیمات
- `KEEP_DAYS`: پیام‌های قدیمی‌تر از این تعداد روز پاک می‌شوند (پیش‌فرض ۳۰).
- `MAX_ROOMS_PER_USER`: حداکثر اتاقی که هر دستگاه می‌تواند بسازد (پیش‌فرض ۵).
- دیتابیس در `server/chat.db` است؛ از همین فایل بکاپ بگیر.
- پورت ۳۰۰۰ را به بیرون باز نکن و فقط از طریق Caddy در دسترس باشد.

## امنیت
- رمز اتاق‌ها هش (scrypt) می‌شود. حداقل ۶ حرف است و تلاش‌های ناموفق محدود می‌شود.
- پیام‌ها رمزنگاری سرتاسری نیستند و مدیر سرور می‌تواند آن‌ها را ببیند. در متن اپ یا قوانین حتماً بنویس.

## عضویت، اعلان و سقف ساخت اتاق
- اتاقی که با رمز واردش شوید در «اتاق‌هایی که عضو هستم» می‌آید و فقط از همین اتاق‌ها اعلان می‌گیرید. سرور هم فقط به اتصال‌هایی پیام می‌فرستد که رمز یا توکن عضویت معتبر داده باشند.
- هر دستگاه حداکثر ۵ اتاق می‌سازد (با شناسه‌ی تصادفی دستگاه شمرده می‌شود، چون حساب کاربری وجود ندارد؛ پاک‌کردن اطلاعات اپ یا نصب دوباره شناسه را عوض می‌کند). سازنده می‌تواند اتاقش را حذف کند.
- اعلان‌ها محلی‌اند و تا وقتی اپ باز یا در پس‌زمینه‌ی فعال است کار می‌کنند. برای اعلان وقتی اپ کاملاً بسته است باید Firebase (FCM) اضافه شود.
- افزونه‌ی `@capacitor/local-notifications` به `package.json` اضافه شده؛ یک بار APK جدید بسازید (Run workflow).
