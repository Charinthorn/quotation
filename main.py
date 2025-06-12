from fastapi import FastAPI, HTTPException, Body, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import gspread
from oauth2client.service_account import ServiceAccountCredentials
import os

app = FastAPI()

# ✅ Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # ปรับให้เหมาะสมถ้าระบุ origin ได้
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ✅ Serve static files and templates
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# ✅ Route HTML หน้าแรก
@app.get("/", response_class=HTMLResponse)
async def root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

# ✅ เชื่อมกับ Google Sheets
scope = ["https://spreadsheets.google.com/feeds", "https://www.googleapis.com/auth/drive"]
SERVICE_ACCOUNT_PATH = os.environ.get("GOOGLE_CREDS_JSON", "client_secret.json")

try:
    creds = ServiceAccountCredentials.from_json_keyfile_name(SERVICE_ACCOUNT_PATH, scope)
    client = gspread.authorize(creds)
    sheet_items = client.open("QuoteVend").worksheet("ชีต1")
    sheet_customers = client.open("QuoteVend").worksheet("ชีต2")
except Exception as e:
    print("❌ Failed to connect to Google Sheets:", e)
    sheet_items = None
    sheet_customers = None

# ✅ POST: เพิ่มสินค้า + ลูกค้า
@app.post("/add_product")
def add_product(product: dict = Body(...)):
    try:
        if not sheet_items or not sheet_customers:
            raise Exception("Google Sheet connection not initialized")

        # เพิ่มสินค้าลงชีต1
        item_row = [
            product.get("quotation_no"),
            product.get("category"),
            product.get("product_id"),
            product.get("name"),
            product.get("price"),
            product.get("quantity"),
        ]
        sheet_items.append_row(item_row)

        # ถ้ายังไม่มีลูกค้า → เพิ่มในชีต2
        existing_customers = sheet_customers.get_all_records()
        exists = any(row["quotation_no"] == product.get("quotation_no") for row in existing_customers)

        if not exists:
            customer_row = [
                product.get("quotation_no"),
                product.get("customer_name"),
                product.get("email"),
                product.get("phone"),
                product.get("company"),
                product.get("address"),
                product.get("notes"),
            ]
            sheet_customers.append_row(customer_row)

        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ✅ GET: ดึงใบเสนอราคาตามหมายเลข
@app.get("/quotation/{quotation_no}")
def get_quotation(quotation_no: str):
    try:
        if not sheet_items or not sheet_customers:
            raise Exception("Google Sheet connection not initialized")

        items = sheet_items.get_all_records()
        matched_items = [row for row in items if row.get("quotation_no") == quotation_no]

        if not matched_items:
            raise HTTPException(status_code=404, detail="Quotation not found")

        customers = sheet_customers.get_all_records()
        customer_row = next((row for row in customers if row.get("quotation_no") == quotation_no), {})

        return {
            "customer": {
                "name": customer_row.get("customer_name", ""),
                "email": customer_row.get("email", ""),
                "phone": customer_row.get("phone", ""),
                "company": customer_row.get("company", ""),
                "address": customer_row.get("address", ""),
                "notes": customer_row.get("notes", "")
            },
            "items": matched_items
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ✅ GET: รายการ quotation_no ทั้งหมด
@app.get("/quotation_list")
def get_quotation_list():
    try:
        if not sheet_items:
            raise Exception("Google Sheet connection not initialized")

        records = sheet_items.get_all_records()
        qnos = list({row["quotation_no"] for row in records if row.get("quotation_no")})
        return sorted(qnos)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
