import pandas as pd
import numpy as np
from flask import Flask, jsonify, render_template, request, redirect, url_for, session, g
import sqlite3
import datetime
import uuid
import random
import os

app = Flask(__name__)
app.secret_key = "super_secret_market_key_123"

# Load dataset (memory constrained subset or fast loading)
print("Loading agricultural dataset...")
try:
    df = pd.read_csv("data.csv")
    df['Price Date'] = pd.to_datetime(df['Price Date'], format="%d %b %Y", errors='coerce')
    df = df.dropna(subset=['Price Date', 'Modal Price (Rs./Quintal)'])
    GLOBAL_CROPS = sorted(df['Commodity'].dropna().unique().tolist())
except Exception as e:
    print(f"Dataset load error: {e}")
    df = pd.DataFrame()
    GLOBAL_CROPS = []

DATABASE = 'market.db'

def get_db():
    db = getattr(g, '_database', None)
    if db is None:
        db = g._database = sqlite3.connect(DATABASE)
        db.row_factory = sqlite3.Row
    return db

@app.teardown_appcontext
def close_connection(exception):
    db = getattr(g, '_database', None)
    if db is not None:
        db.close()

def init_db():
    db = get_db()
    cursor = db.cursor()
    
    # Ensure tables exist
    cursor.execute('''CREATE TABLE IF NOT EXISTS users (
                        username TEXT PRIMARY KEY,
                        password TEXT,
                        role TEXT)''')
                        
    cursor.execute('''CREATE TABLE IF NOT EXISTS inventory (
                        id TEXT PRIMARY KEY,
                        farmer_name TEXT,
                        district TEXT,
                        crop TEXT,
                        quantity REAL,
                        price REAL)''')
                        
    cursor.execute('''CREATE TABLE IF NOT EXISTS orders (
                        id TEXT PRIMARY KEY,
                        username TEXT,
                        farmer_name TEXT,
                        crop TEXT,
                        quantity REAL,
                        price REAL,
                        total REAL,
                        status TEXT,
                        date TEXT)''')
    
    # Seed users if missing
    cursor.execute("SELECT COUNT(*) FROM users")
    if cursor.fetchone()[0] == 0:
        cursor.execute("INSERT INTO users VALUES ('farmer', 'password123', 'farmer')")
        cursor.execute("INSERT INTO users VALUES ('buyer', 'password123', 'customer')")
        
    # Seed inventory if missing
    cursor.execute("SELECT COUNT(*) FROM inventory")
    if cursor.fetchone()[0] == 0 and not df.empty and 'District Name' in df.columns:
        mock_farmers = ["Ramesh Kumar", "Suresh Singh", "Amit Patel", "Vikram Sharma", "Harish Verma", "Rajesh Tiwari", "Sanjay Gupta", "Mohan Lal"]
        top_crops_for_inv = GLOBAL_CROPS[:20] if GLOBAL_CROPS else ["Wheat", "Potato", "Apple"]
        dist_for_inv = df['District Name'].dropna().unique().tolist()[:10]
        
        for _ in range(15):
            cursor.execute('''INSERT INTO inventory VALUES (?, ?, ?, ?, ?, ?)''',
                           (str(uuid.uuid4())[:8],
                            random.choice(mock_farmers),
                            random.choice(dist_for_inv) if dist_for_inv else "Agra",
                            random.choice(top_crops_for_inv),
                            random.randint(10, 200),
                            random.randint(1000, 5000)))
    db.commit()

with app.app_context():
    init_db()

@app.route('/')
def home():
    if 'user' in session:
        if session.get('role') == 'customer':
            return redirect(url_for('customer_dashboard'))
        return redirect(url_for('dashboard'))
    return redirect(url_for('login'))

@app.route('/login', methods=['GET', 'POST'])
def login():
    error = None
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        db = get_db()
        cur = db.cursor()
        cur.execute("SELECT password, role FROM users WHERE username = ?", (username,))
        user_record = cur.fetchone()
        
        if user_record and user_record['password'] == password:
            session['user'] = username
            session['role'] = user_record['role']
            if session['role'] == 'customer':
                return redirect(url_for('customer_dashboard'))
            return redirect(url_for('dashboard'))
        error = "Invalid credentials. Try farmer/password123 or buyer/password123"
    return render_template('login.html', error=error)

@app.route('/logout')
def logout():
    session.pop('user', None)
    session.pop('role', None)
    return redirect(url_for('login'))

@app.route('/customer_dashboard')
def customer_dashboard():
    if 'user' not in session or session.get('role') != 'customer':
        return redirect(url_for('login'))
        
    highlights = {}
    districts = []
    if not df.empty:
        df_clean = df.dropna(subset=['Commodity'])
        if 'District Name' in df.columns:
            districts = sorted(df['District Name'].dropna().unique().tolist())
            
        latest_data = df_clean.sort_values(by='Price Date', ascending=False).head(200)
        top_crops = latest_data['Commodity'].value_counts().head(8).index.tolist()
        
        for c in top_crops:
            avg_price = latest_data[latest_data['Commodity'] == c]['Modal Price (Rs./Quintal)'].mean()
            highlights[c] = round(avg_price, 2)
            
    return render_template('customer_dashboard.html', 
                            username=session['user'],
                            highlights=highlights,
                            districts=districts)

@app.route('/api/buy', methods=['POST'])
def buy_crop():
    if 'user' not in session or session.get('role') != 'customer':
        return jsonify({"error": "Unauthorized"}), 401
        
    data = request.json
    inv_id = data.get('inventory_id')
    try:
        quantity = float(data.get('quantity', 1))
    except ValueError:
        return jsonify({"error": "Invalid quantity"}), 400
        
    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT * FROM inventory WHERE id = ?", (inv_id,))
    item = cur.fetchone()
    
    if not item:
        return jsonify({"error": "Listing not found or expired."}), 404
        
    if quantity > item['quantity']:
        return jsonify({"error": f"Insufficient stock. Only {item['quantity']} quintals available."}), 400
        
    if quantity <= 0:
        return jsonify({"error": "Quantity must be greater than zero."}), 400
        
    new_quantity = item['quantity'] - quantity
    cur.execute("UPDATE inventory SET quantity = ? WHERE id = ?", (new_quantity, inv_id))
    
    price_per_q = item['price']
    total = quantity * price_per_q
    
    order_id = f"ORD-{str(uuid.uuid4())[:8].upper()}"
    date_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    
    cur.execute("INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", 
                (order_id, session['user'], item['farmer_name'], item['crop'], quantity, price_per_q, total, "Processing", date_str))
    db.commit()
    
    order = {
        "id": order_id,
        "user": session['user'],
        "farmer": item['farmer_name'],
        "crop": item['crop'],
        "quantity": quantity,
        "price": price_per_q,
        "total": total,
        "status": "Processing",
        "date": date_str
    }
    return jsonify({"success": True, "order": order})

@app.route('/api/inventory')
def get_inventory():
    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT * FROM inventory WHERE quantity > 0")
    items = [dict(row) for row in cur.fetchall()]
    return jsonify(items)

@app.route('/orders')
def get_orders():
    if 'user' not in session or session.get('role') != 'customer':
        return jsonify([])
    
    db = get_db()
    cur = db.cursor()
    cur.execute("SELECT * FROM orders WHERE username = ?", (session['user'],))
    user_orders = [dict(row) for row in cur.fetchall()]
    return jsonify(user_orders)

@app.route('/api/cancel_order', methods=['POST'])
def cancel_order():
    if 'user' not in session or session.get('role') != 'customer':
        return jsonify({"error": "Unauthorized"}), 401

    order_id = request.json.get('order_id')
    db = get_db()
    cur = db.cursor()
    
    cur.execute("SELECT * FROM orders WHERE id = ? AND username = ?", (order_id, session['user']))
    order = cur.fetchone()
    if not order:
        return jsonify({"error": "Order not found"}), 404
        
    if order['status'] == "Cancelled":
        return jsonify({"error": "Order is already cancelled"}), 400
        
    cur.execute("UPDATE inventory SET quantity = quantity + ? WHERE farmer_name = ? AND crop = ?", 
                (order['quantity'], order['farmer_name'], order['crop']))
    
    cur.execute("UPDATE orders SET status = 'Cancelled' WHERE id = ?", (order_id,))
    db.commit()
    
    return jsonify({"success": True})

@app.route('/api/crops')
def search_crops_list():
    query = request.args.get('q', '').lower()
    if not query:
        return jsonify(GLOBAL_CROPS[:25])
    matches = [c for c in GLOBAL_CROPS if query in c.lower()]
    return jsonify(matches[:25])


@app.route('/dashboard')
def dashboard():
    if 'user' not in session or session.get('role') == 'customer':
        return redirect(url_for('login'))
        
    farmer_district = "All Regions"
    recent_crops = []
    highlights = {}
    districts = []
    
    if not df.empty:
        df_clean = df.dropna(subset=['Commodity'])
        all_unique = df_clean['Commodity'].unique().tolist()
        
        if 'District Name' in df.columns:
            districts = sorted(df['District Name'].dropna().unique().tolist())
        
        # Priority sort to bring Paddy to front if it exists
        if 'Paddy' in all_unique:
            all_unique.remove('Paddy')
            all_unique.insert(0, 'Paddy')
            
        recent_crops = all_unique[:6]
        
        latest_data = df_clean.sort_values(by='Price Date', ascending=False).head(200)
        grouped = latest_data.groupby('Commodity')['Modal Price (Rs./Quintal)'].mean()
        top_crops = grouped.sort_values(ascending=False).head(3).index.tolist()
        
        for c in top_crops:
            highlights[c] = round(grouped[c], 2)
            
        # Demand Analysis Tracker
        high_demand, medium_demand, low_demand = [], [], []
        popular_crops = latest_data['Commodity'].value_counts().head(10).index.tolist()
        
        for crop in popular_crops:
            c_data = df_clean[df_clean['Commodity'] == crop].sort_values(by='Price Date', ascending=False)
            if len(c_data) >= 10:
                recent_avg = c_data.head(5)['Modal Price (Rs./Quintal)'].mean()
                past_avg = c_data.iloc[5:10]['Modal Price (Rs./Quintal)'].mean()
                if past_avg > 0:
                    ratio = recent_avg / past_avg
                    if ratio >= 1.02:
                        high_demand.append(crop)
                    elif ratio <= 0.98:
                        low_demand.append(crop)
                    else:
                        medium_demand.append(crop)
            else:
                medium_demand.append(crop)
                
        # Deduplicate and limit to 3 each to fit UI nicely
        high_demand = list(set(high_demand))[:3]
        medium_demand = list(set(medium_demand))[:3]
        low_demand = list(set(low_demand))[:3]
            
    return render_template('dashboard.html', 
                            username=session['user'],
                            recent_crops=recent_crops,
                            highlights=highlights,
                            high_demand=high_demand,
                            medium_demand=medium_demand,
                            low_demand=low_demand,
                            districts=districts)

@app.route('/price/<crop>')
def get_price(crop):
    if df.empty:
        return jsonify([])
    result = df[df['Commodity'].str.lower() == crop.lower()]
    recent = result.sort_values(by='Price Date', ascending=False)
    # Convert dates to string so JSON serializes properly
    recent['Price Date'] = recent['Price Date'].dt.strftime('%Y-%m-%d')
    return recent.head(10).to_json(orient='records')

@app.route('/predict/<crop>')
def predict_price(crop):
    if df.empty:
        return jsonify({"error": "Dataset missing"})
    
    district = request.args.get('district')
    
    if district and 'District Name' in df.columns:
        result = df[(df['Commodity'].str.lower() == crop.lower()) & (df['District Name'].str.lower() == district.lower())].copy()
    else:
        result = df[df['Commodity'].str.lower() == crop.lower()].copy()
        
    if len(result) < 5:
        loc = f" in {district}" if district else ""
        return jsonify({"error": f"Not enough data for {crop}{loc}"})
    
    result = result.sort_values(by='Price Date')
    result['Date_Ordinal'] = result['Price Date'].apply(lambda dt: dt.toordinal())
    
    x = result['Date_Ordinal'].values
    y = result['Modal Price (Rs./Quintal)'].values
    
    m, b = np.polyfit(x, y, 1)
    
    last_date = result['Price Date'].max()
    future_date = last_date + pd.Timedelta(days=30)
    future_ordinal = future_date.toordinal()
    
    predicted_price = m * future_ordinal + b
    current_avg = y[-10:].mean()
    
    trend = "UP" if m > 0 else "DOWN"
    diff = predicted_price - current_avg
    
    return jsonify({
        "crop": crop.capitalize(),
        "current_avg_price": round(current_avg, 2),
        "predicted_price_30_days": round(predicted_price, 2),
        "trend": trend,
        "difference": round(diff, 2),
        "future_date": future_date.strftime("%B %d, %Y")
    })

@app.route('/api/analytics')
def farmer_analytics():
    district = request.args.get('district', '')
    
    highlights = {}
    high_demand, medium_demand, low_demand = [], [], []
    
    if not df.empty:
        df_clean = df.dropna(subset=['Commodity']).copy()
        if district and 'District Name' in df_clean.columns:
            df_clean = df_clean[df_clean['District Name'] == district]
            
        if not df_clean.empty:
            latest_data = df_clean.sort_values(by='Price Date', ascending=False).head(200)
            grouped = latest_data.groupby('Commodity')['Modal Price (Rs./Quintal)'].mean()
            top_crops = grouped.sort_values(ascending=False).head(3).index.tolist()
            
            for c in top_crops:
                highlights[c] = round(grouped[c], 2)
                
            popular_crops = latest_data['Commodity'].value_counts().head(10).index.tolist()
            
            for crop in popular_crops:
                c_data = df_clean[df_clean['Commodity'] == crop].sort_values(by='Price Date', ascending=False)
                if len(c_data) >= 10:
                    recent_avg = c_data.head(5)['Modal Price (Rs./Quintal)'].mean()
                    past_avg = c_data.iloc[5:10]['Modal Price (Rs./Quintal)'].mean()
                    if past_avg > 0:
                        ratio = recent_avg / past_avg
                        if ratio >= 1.02:
                            high_demand.append(crop)
                        elif ratio <= 0.98:
                            low_demand.append(crop)
                        else:
                            medium_demand.append(crop)
                else:
                    medium_demand.append(crop)
                    
            high_demand = list(set(high_demand))[:3]
            medium_demand = list(set(medium_demand))[:3]
            low_demand = list(set(low_demand))[:3]
            
    return jsonify({
        "highlights": highlights,
        "high_demand": high_demand,
        "medium_demand": medium_demand,
        "low_demand": low_demand
    })

if __name__ == "__main__":
    app.run(debug=True)