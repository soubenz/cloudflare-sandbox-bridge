# Zakat calculator

Static Cloudflare Worker (assets only). All maths runs in the browser; entries are kept in `localStorage`.

Rules (from the Notion "Zakat" page): cash, Qardus/Kapitalboost, Godwin and yielder rental income count in full; stocks/equity ETFs count 40% (1% overall); sukuk/property/REIT funds are exempt; debts are deducted from the cash-like assets; 2.5% rate.

    npm run dev:zakat      # http://localhost:8791
    npm run deploy:zakat
