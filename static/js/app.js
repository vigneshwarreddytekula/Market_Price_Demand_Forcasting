document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('calculator-form');
    // Early exit if on login page
    if(!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const crop = document.getElementById('crop').value;
        const quantity = parseFloat(document.getElementById('quantity').value);
        const cost = parseFloat(document.getElementById('cost').value);
        
        const btn = form.querySelector('button');
        btn.innerHTML = "Computing...";
        btn.disabled = true;
        
        try {
            document.getElementById('results-grid').style.display = 'none';
            document.getElementById('ai-alert').style.display = 'block';
            document.getElementById('alert-crop').innerText = crop;

            // Fetch AI Prediction which also contains average price
            let url = `/predict/${encodeURIComponent(crop)}`;
            const distSelect = document.getElementById('farmer-district-select');
            if (distSelect && distSelect.value) {
                url += `?district=${encodeURIComponent(distSelect.value)}`;
            }
            const response = await fetch(url);
            const data = await response.json();
            
            if (data.error) {
                alert("Error: " + data.error);
                throw new Error(data.error);
            }
            
            // Render P&L
            const currentAvg = data.current_avg_price;
            const revenue = currentAvg * quantity;
            const profitLoss = revenue - cost;
            
            document.getElementById('res-price').innerText = `Rs. ${currentAvg}`;
            document.getElementById('res-revenue').innerText = `Rs. ${revenue.toLocaleString()}`;
            
            const plRow = document.getElementById('res-pl');
            if(profitLoss >= 0) {
                plRow.innerText = `+ Rs. ${profitLoss.toLocaleString()}`;
                plRow.className = "profit-text";
            } else {
                plRow.innerText = `- Rs. ${Math.abs(profitLoss).toLocaleString()}`;
                plRow.className = "loss-text";
            }
            
            // Render AI
            document.getElementById('ai-future-date').innerText = `Target Date: ${data.future_date}`;
            document.getElementById('ai-price').innerText = `Rs. ${data.predicted_price_30_days}`;
            
            const trendBox = document.getElementById('ai-trend-box');
            if (data.trend === "UP") {
                trendBox.className = "trend-box trend-up";
                document.getElementById('ai-trend-icon').innerText = "📈";
                document.getElementById('ai-trend-text').innerText = `Expected to increase by Rs. ${data.difference}`;
                document.getElementById('ai-suggestion').innerText = `Recommendation: The AI forecasts prices strictly going UP. Consider waiting or staging your sales to maximize future profits.`;
            } else {
                trendBox.className = "trend-box trend-down";
                document.getElementById('ai-trend-icon').innerText = "📉";
                document.getElementById('ai-trend-text').innerText = `Expected to drop by Rs. ${Math.abs(data.difference)}`;
                document.getElementById('ai-suggestion').innerText = `Recommendation: The AI predicts a downward market dip. It is highly recommended to sell your yield soon to avoid losses.`;
            }
            
            document.getElementById('ai-alert').style.display = 'none';
            document.getElementById('results-grid').style.display = 'grid';

        } catch (err) {
            console.error(err);
            document.getElementById('ai-alert').style.display = 'none';
        } finally {
            btn.innerHTML = "Calculate & Predict";
            btn.disabled = false;
        }
    });

    // Subtle crop typing animation
    const cropInput = document.getElementById('crop');
    cropInput.addEventListener('input', () => {
        if(cropInput) {
            cropInput.style.borderColor = cropInput.value.length > 1 ? "var(--primary)" : "var(--glass-border)";
        }
    });

    // Buy Form block was removed as we migrated to dynamic inventory.
});

// CUSTOMER DASHBOARD FUNCTIONS
function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    
    document.getElementById(`tab-${tabId}`).style.display = 'block';
    
    const indexMap = { 'search': 0, 'prices': 1, 'buy': 2, 'orders': 3 };
    document.querySelectorAll('.tab-btn')[indexMap[tabId]].classList.add('active');
    
    if (tabId === 'orders') {
        loadOrders();
    } else if (tabId === 'search') {
        const query = document.getElementById('crop-search').value.trim();
        loadAvailableCrops(query);
    } else if (tabId === 'buy') {
        loadInventory();
    }
}

let currentSearchController = null;

async function loadAvailableCrops(query = '') {
    try {
        const response = await fetch(`/api/crops?q=${encodeURIComponent(query)}`);
        const data = await response.json();
        
        const container = document.getElementById('suggested-crops');
        if (!container) return;
        
        if (data.length === 0) {
            container.innerHTML = '<span class="crop-tag" style="opacity:0.5;">No matching crops</span>';
            return;
        }
        
        let html = '';
        data.forEach(crop => {
            html += `<span class="crop-tag" style="cursor:pointer;" onclick="selectCrop('${crop}')">${crop}</span>`;
        });
        container.innerHTML = html;
    } catch(err) {
        console.error("Failed to load crops", err);
    }
}

function selectCrop(cropName) {
    document.getElementById('crop-search').value = cropName;
    document.getElementById('search-results').innerHTML = '<p class="card-subtitle" style="text-align: center; width: 100%;">Fetching market value...</p>';
    runPredictor(cropName);
}

async function searchCrops() {
    const query = document.getElementById('crop-search').value.trim();
    loadAvailableCrops(query);
    
    if (query.length < 3) {
        document.getElementById('search-results').innerHTML = '<p class="card-subtitle" style="text-align: center; width: 100%;">Select a crop above to see market details.</p>';
        if (currentSearchController) currentSearchController.abort();
        return;
    }
    runPredictor(query);
}

async function runPredictor(query) {
    const districtSelect = document.getElementById('district-search');
    const district = districtSelect ? districtSelect.value : "";
    
    if (currentSearchController) {
        currentSearchController.abort();
    }
    currentSearchController = new AbortController();
    const signal = currentSearchController.signal;
    
    let url = `/predict/${encodeURIComponent(query)}`;
    if (district) {
        url += `?district=${encodeURIComponent(district)}`;
    }
    
    try {
        const response = await fetch(url, { signal });
        const data = await response.json();
        
        // Fetch inventory to show basic farmer details
        const invRes = await fetch('/api/inventory');
        const invData = await invRes.json();
        
        let html = '';
        if (data.error) {
            html = `<p class="card-subtitle" style="text-align: center; width: 100%; color:var(--danger);">${data.error}</p>`;
        } else {
            const farmersForCrop = invData.filter(i => i.crop.toLowerCase() === query.toLowerCase());
            let farmerInfo = "";
            if (farmersForCrop.length > 0) {
                farmerInfo = `<div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid rgba(255,255,255,0.1);">
                    <strong style="color:var(--text-muted); font-size:0.9rem;">Current Local Availability:</strong>
                    <ul style="list-style:none; margin-top:8px;">`;
                farmersForCrop.forEach(f => {
                    farmerInfo += `<li style="font-size:0.95rem; margin-bottom:5px;"><strong>${f.farmer_name}</strong> (District: ${f.district}) - Available: ${f.quantity} Q at Rs. ${f.price}/Q</li>`;
                });
                farmerInfo += `</ul></div>`;
            } else {
                farmerInfo = `<div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid rgba(255,255,255,0.1); font-size:0.9rem; color:var(--danger);">No local farmers currently have this in stock.</div>`;
            }

            html = `
                <div class="search-card" style="flex-direction: column; align-items: flex-start; gap: 10px;">
                    <div style="display: flex; justify-content: space-between; width: 100%; align-items: center;">
                        <div>
                            <strong style="font-size:1.2rem; color:var(--text-main);">${data.crop}</strong>
                            <div style="font-size:0.9rem; color:var(--text-muted); margin-top:5px;">Recent Trend: ${data.trend === 'UP' ? 'Rising' : 'Falling'}</div>
                        </div>
                        <div style="text-align:right;">
                            <div style="font-size:1.2rem; font-weight:600; color:var(--primary);">Rs. ${data.current_avg_price} / Q</div>
                        </div>
                    </div>
                    ${farmerInfo}
                </div>
            `;
        }
        document.getElementById('search-results').innerHTML = html;
    } catch(err) {
        if (err.name === 'AbortError') {
            console.log("Fetch aborted for outdated query");
        } else {
            console.error(err);
        }
    }
}

// The function was explicitly removed because the buy form was replaced.

async function loadOrders() {
    const list = document.getElementById('orders-list');
    list.innerHTML = '<p class="card-subtitle">Loading order history...</p>';
    
    try {
        const response = await fetch('/orders');
        const orders = await response.json();
        
        if (orders.length === 0) {
            list.innerHTML = '<p class="card-subtitle" style="text-align:center;">You have no past orders.</p>';
            return;
        }
        
        let html = '';
        orders.reverse().forEach(o => {
            let cancelBtn = '';
            let statusColor = o.status === 'Cancelled' ? 'var(--danger)' : 'var(--primary)';
            if (o.status === 'Processing') {
                cancelBtn = `<button class="btn" style="margin-top:5px; padding:4px 8px; font-size:0.8rem; background:rgba(239, 68, 68, 0.2); color:var(--danger); border:1px solid var(--danger);" onclick="cancelOrder('${o.id}')">Cancel Order</button>`;
            }
            html += `
                <div class="order-card" style="grid-template-columns: 1.5fr 1fr 1fr 1fr;">
                    <div>
                        <div style="color:var(--text-muted); font-size:0.9rem;">Order ID / Detail</div>
                        <strong>${o.id}</strong>
                        <div style="color:var(--text-muted); font-size:0.8rem; margin-top:3px;">From: ${o.farmer}</div>
                    </div>
                    <div>
                        <div style="color:var(--text-muted); font-size:0.9rem;">Crop Details</div>
                        <strong>${o.quantity} Quintals of ${o.crop}</strong>
                    </div>
                    <div>
                        <div style="color:var(--text-muted); font-size:0.9rem;">Total Paid</div>
                        <strong>Rs. ${o.total.toFixed(2)}</strong>
                    </div>
                    <div style="text-align: right;">
                        <div class="order-status" style="color:${statusColor}; border-color:${statusColor}; display:inline-block;">${o.status}</div>
                        <div style="text-align: right;">${cancelBtn}</div>
                    </div>
                </div>
            `;
        });
        list.innerHTML = html;
        
    } catch(err) {
        list.innerHTML = '<p class="card-subtitle" style="color:var(--danger);">Failed to load orders.</p>';
    }
}

async function cancelOrder(orderId) {
    if (!confirm('Are you sure you want to cancel this order? It will revert the stock back to the farmer.')) return;
    
    try {
        const response = await fetch('/api/cancel_order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order_id: orderId })
        });
        const resData = await response.json();
        if (resData.success) {
            loadOrders(); // Reload the list
        } else {
            alert(resData.error || 'Failed to cancel order.');
        }
    } catch(err) {
        console.error(err);
        alert('An error occurred during cancellation.');
    }
}

async function loadInventory() {
    const list = document.getElementById('inventory-list');
    list.innerHTML = '<p class="card-subtitle">Loading live market inventory...</p>';
    
    try {
        const response = await fetch('/api/inventory');
        const items = await response.json();
        
        if (items.length === 0) {
            list.innerHTML = '<p class="card-subtitle" style="text-align:center;">No available inventory. Farmers are currently out of stock.</p>';
            return;
        }
        
        let html = '';
        items.forEach(i => {
            html += `
                <div class="order-card" style="grid-template-columns: 2fr 1fr 1fr 1.5fr;">
                    <div>
                        <strong style="color:var(--primary); font-size:1.1rem;">${i.farmer_name}</strong>
                        <div style="color:var(--text-muted); font-size:0.9rem;">📍 ${i.district}</div>
                    </div>
                    <div>
                        <strong style="font-size:1.1rem;">${i.crop}</strong>
                        <div style="color:var(--text-muted); font-size:0.85rem;">Stock: ${i.quantity} Q</div>
                    </div>
                    <div>
                        <strong style="font-size:1.1rem;">Rs. ${i.price}</strong>
                        <div style="color:var(--text-muted); font-size:0.85rem;">per Quintal</div>
                    </div>
                    <div style="display:flex; gap:10px; align-items:center;">
                        <input type="number" id="qty-${i.id}" value="1" min="1" max="${i.quantity}" style="width:70px; padding:8px; border-radius:6px; background:rgba(15,23,42,0.6); color:white; border:1px solid var(--glass-border);">
                        <button class="btn primary-btn" style="padding:8px 12px; font-size:0.9rem;" onclick="placeOrder('${i.id}')">Buy</button>
                    </div>
                </div>
            `;
        });
        list.innerHTML = html;
    } catch(err) {
        list.innerHTML = '<p class="card-subtitle" style="color:var(--danger);">Failed to load inventory.</p>';
    }
}

async function placeOrder(inventoryId) {
    const qtyInput = document.getElementById(`qty-${inventoryId}`);
    const quantity = parseFloat(qtyInput.value);
    
    document.getElementById('order-success').style.display = 'none';
    document.getElementById('order-error').style.display = 'none';

    // UI disable
    const btn = qtyInput.nextElementSibling;
    const oldBtnText = btn.innerHTML;
    btn.innerHTML = '...';
    btn.disabled = true;

    try {
        const response = await fetch('/api/buy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ inventory_id: inventoryId, quantity: quantity })
        });
        const resData = await response.json();
        
        if (response.ok && resData.success) {
            document.getElementById('order-success').style.display = 'block';
            setTimeout(() => {
                document.getElementById('order-success').style.display = 'none';
                switchTab('orders');
            }, 1000);
        } else {
            document.getElementById('order-error').style.display = 'block';
            document.getElementById('order-error-msg').innerText = resData.error || "Transaction failed.";
        }
    } catch (err) {
        console.error(err);
    } finally {
        btn.innerHTML = oldBtnText;
        btn.disabled = false;
    }
}

async function updateFarmerAnalytics() {
    const districtSelect = document.getElementById('farmer-district-select');
    if (!districtSelect) return;
    
    const district = districtSelect.value;
    let url = '/api/analytics';
    if (district) {
        url += `?district=${encodeURIComponent(district)}`;
    }
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        
        const highlightsList = document.getElementById('dynamic-highlights-list');
        if (highlightsList) {
            let html = '';
            const crops = Object.keys(data.highlights);
            if (crops.length > 0) {
                crops.forEach(crop => {
                    html += `
                        <li>
                            <strong>${crop}</strong>
                            <span>Rs. ${data.highlights[crop]} / Quintal</span>
                        </li>
                    `;
                });
            } else {
                html = '<li>No market data available here.</li>';
            }
            highlightsList.innerHTML = html;
        }
        
        const hd = document.getElementById('dynamic-high-demand');
        if (hd) hd.innerText = data.high_demand.length > 0 ? data.high_demand.join(', ') : 'None currently';
        
        const md = document.getElementById('dynamic-medium-demand');
        if (md) md.innerText = data.medium_demand.length > 0 ? data.medium_demand.join(', ') : 'None currently';
        
        const ld = document.getElementById('dynamic-low-demand');
        if (ld) ld.innerText = data.low_demand.length > 0 ? data.low_demand.join(', ') : 'None currently';
        
    } catch(err) {
        console.error("Failed to update analytics", err);
    }
}
