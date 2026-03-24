# Table Assistance Ping App

This app gives restaurant guests a fast way to request help from their table and gives staff a live dashboard that can stay open on a Toast device browser.

## Included now

- Real-time customer-to-server table assistance alerts
- SQLite persistence so alerts and tables survive restarts
- A welcome page at `/`
- A customer page at `/customer`
- Table-specific customer links at `/table/<slug>`
- A live server dashboard at `/server`
- An admin screen at `/admin` to create, print, enable, and disable table links
- Staff PIN protection for `/server` and `/admin`
- A shift sign-in flow for restaurant, server name, and assigned tables

## Run it

Use the system Python directly:

```bash
export STAFF_PIN=1111
/usr/bin/python3 app.py
```

Then open:

- `http://127.0.0.1:8000/` for the welcome screen
- `http://127.0.0.1:8000/customer` for the generic customer screen
- `http://127.0.0.1:8000/server` for the staff dashboard
- `http://127.0.0.1:8000/admin` for table setup and printable cards

## Recommended workflow

1. Open `/admin`
2. Create a batch of tables
3. Print the generated cards
4. Place one card on each table
5. Keep `/server` open on the staff-facing device

## Notes

- Data is stored in `app.db`
- Staff sessions are stored in memory and the staff PIN comes from the `STAFF_PIN` environment variable
- The admin screen uses a hosted QR image service to render printable QR codes for each table link
- This still is not a direct Toast POS integration. It is a browser-based staff alert workflow designed to work alongside Toast devices

## Practical next step after this

If you want to keep pushing toward production, the next layer would be:

- an alert escalation timer
- server assignment by dining section
- a Toast-approved integration or webhook flow if your Toast setup allows it
