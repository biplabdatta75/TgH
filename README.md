# TgH jewelry store (initial build)

This is a small, self-contained full-stack starter for the jewelry store modules in `Modules_with_Functions.xlsx`. It uses Node.js built-in modules and browser JavaScript, so there are no package dependencies to install.

## Run locally

1. Install Node.js 20 or newer.
2. Open a terminal in this folder.
3. Run `npm start` (or `node server.js`).
4. Visit `http://127.0.0.1:4173` for the storefront.
5. Visit `http://127.0.0.1:4173/admin.html` for the admin area.

On the first run the server generates an admin password, prints it in the terminal, and saves it to `data/admin-password.txt`. You can also set the `ADMIN_PASSWORD` environment variable before starting the server. For example, in PowerShell: `$env:ADMIN_PASSWORD = 'choose-a-long-unique-password'; npm start`.

## Included in this starter

- Responsive storefront, category pages, product details, search, jewelry filters, sorting, top-rated collections, wishlist, and cart.
- Checkout that validates product availability, applies active discount codes, calculates order totals, and saves an order for store follow-up.
- Customer accounts with sign-up, sign-in, and order history.
- Customer reviews with optional image upload, moderation queue, and removal controls in Admin.
- Admin overview, editable homepage/brand/policy content, homepage and product image uploads, catalog management, inventory quantities, order and fulfillment status, customer list, promotions, review moderation, and order CSV export.
- Store configuration and orders are stored in `data/store.json`; uploaded images are stored in `uploads/`.

## Configuration and current limits

- This initial build records orders but does **not** charge cards or process live payments. Connect a payment provider (such as Stripe or Razorpay) and configure its credentials and payment callbacks before taking online payments.
- Customer accounts use email and password. Email/phone one-time-code verification needs an email or SMS provider.
- Data uses a local JSON file for ease of setup. For a public, multi-user launch, move it to a database, serve the app behind HTTPS, add backups and monitoring, and review authentication, privacy, tax, shipping, and consumer-law requirements for your market.
- The server binds to `127.0.0.1` by default. Do not expose this starter directly to the public internet without production hosting and security work.
- Images can be uploaded as PNG, JPEG, or WebP up to 8 MB for store content/products and 3 MB for customer reviews.

## Customize the store

Use **Store admin → Store content** to change the brand name, announcement, homepage copy and hero image, story section, contact email, currency symbol, footer text, and policy pages. Use **Products** to change product names, descriptions, collections, prices, metal and gemstone details, sizes, stock, visibility, and images. Product/category edits are saved to the store data automatically.


