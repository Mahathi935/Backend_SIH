from fastapi import FastAPI
import json

app = FastAPI()

# Load dummy data from JSON file
with open("dummy_data.json") as f:
    DUMMY_DB = json.load(f)

@app.get("/check_availability/{product_code}")
async def check_availability(product_code: str):
    product = DUMMY_DB.get(product_code)
    if not product:
        return {"error": "Product not found"}
    
    return {
        "product_code": product_code,
        "name": product["name"],
        "available": bool(product["in_stock"]),
        "quantity": product["quantity"]
    }
