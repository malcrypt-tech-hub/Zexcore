# Online shop and product photos (Cloudinary)

Businesses list goods under **Shop** in the dashboard. Customers see them on the booking page (a "Shop" tab), choose quantities, give a name, phone number
and delivery address, and send an **order request**. Nothing is charged online: the business confirms the order and agrees payment with the customer.
Prices are list prices in US dollars, like services. Plan caps on products: Free 5, Starter 30, Growth 200, Agency 1,000, Enterprise 5,000.

## Photo uploads

Product photos are uploaded straight from the browser to your Cloudinary account. The Worker signs each upload (so the API secret never reaches the browser)
and limits it to the workspace's own folder (`zexcore/<workspaceId>/products`) and to JPG, PNG and WebP. The app also refuses files over 5 MB.

Set the three Worker secrets (Cloudinary dashboard: Settings, then API Keys; the cloud name is shown at the top of the dashboard):

```sh
cd workers/payments
npx wrangler secret put CLOUDINARY_CLOUD_NAME
npx wrangler secret put CLOUDINARY_API_KEY
npx wrangler secret put CLOUDINARY_API_SECRET
```

Then redeploy the Worker, Firestore rules and hosting together (`firebase.json` now allows `https://api.cloudinary.com` for uploads; pictures load from `https://res.cloudinary.com`).

Until the secrets are set, the product form still works but photo upload says "Photo upload is not switched on yet."

## What is stored

* `workspaces/{id}/products/{g_n}`: name, description, price (USD minor units), active, inStock, imageUrl (must start with `https://res.cloudinary.com/`).
* `workspaces/{id}/orders/{id}`: created only by the Worker (`POST /api/public/order`), which re-reads every price from the products. Staff can change `status` only.
* Order requests are included in "Their data" downloads and removed by erasure; deleting an account wipes products and orders. Photos already uploaded stay in
  Cloudinary until you delete them there (the Worker holds no delete permission by design).

## Not built yet

Online payment at checkout, customer photo uploads, stock counts (only an in-stock switch), shipping fees.
