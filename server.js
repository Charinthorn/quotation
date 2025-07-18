const xlsx = require('xlsx'); 
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { google } = require('googleapis');

const app = express();
const helmet = require('helmet');
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use('/images', express.static(path.join(__dirname, 'public/images')));
app.use('/uploaded_images', express.static(path.join(__dirname, 'public/uploaded_images')));

const upload = multer({ dest: 'public/uploaded_images/' });

// Google Sheets setup
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON || '{}');

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive'
  ]
});

const drive = google.drive({ version: 'v3', auth });

let sheetsClient;
let sheet;

let sheet_items, sheet_customers, sheet_basic, sheet_categories, sheet_pipes;
let products_cache = [];
let categories_cache = [];

async function initSheets() {
  const authClient = await auth.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: authClient });

  const spreadsheet = await google.drive({ version: 'v3', auth: authClient })
    .files.list({ q: "name='QuoteVend'", fields: 'files(id, name)' });

  const spreadsheetId = spreadsheet.data.files[0].id;

  sheet = { spreadsheetId };

  sheet_items = 'ชีต1';
  sheet_customers = 'ชีต2';       
  sheet_customer_master = 'customer';  
  sheet_basic = 'ชีต3';
  sheet_categories = 'ชีต4';
  sheet_pipes = 'pipe';
  sheet_dwg = 'dwg';

  await loadDataOnStartup();
}

async function loadDataOnStartup() {
  const basic = await getRecords(sheet_basic);
  const pipe = await getRecords(sheet_pipes);
  const pipeFormatted = pipe.map((row) => ({
    product_id: `P${row.product_id || ''}`,
    name: `Custom PTFE ${row.diameter || ''}" (${row.length || ''}mm)`,
    price: parseFloat(row.price || 9.99),
    category: 'pipe',
    sub_category: row.sub_category || '',
    description: 'No description available',
    diameter: row.diameter || '',
    length: row.length || '',
    ptfeGrade: row.ptfeGrade || '',
    coating: row.coating || '',
    flangeConfig: row.flange || '',
    ventHole: (row.ventHole || '').trim().toLowerCase() === 'yes',
    grounding: (row.grounding || '').trim().toLowerCase() === 'yes',
    vacuumRated: (row.vacuumRated || '').trim().toLowerCase() === 'yes'
  }));

  products_cache = basic.concat(pipeFormatted);
  categories_cache = await getRecords(sheet_categories);
  console.log(`\u2705 Loaded ${products_cache.length} products, ${categories_cache.length} categories at startup.`);
}

async function getRecords(sheetName) {
  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: sheet.spreadsheetId,
    range: sheetName,
  });

  const [header, ...rows] = res.data.values;
  return rows.map((row) => Object.fromEntries(header.map((h, i) => [h, row[i] || ''])));
}

app.post('/refresh_data', async (req, res) => {
  try {
    await loadDataOnStartup();
    res.json({
      status: 'refreshed',
      product_count: products_cache.length,
      category_count: categories_cache.length,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to refresh data' });
  }
});

app.post('/upload_image', upload.single('file'), (req, res) => {
  res.json({ url: `/uploaded_images/${req.file.filename}` });
});

// เพิ่ม Category APIs
app.post('/add_category', async (req, res) => {
  try {
    const { category_id, name, icon } = req.body;
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: sheet.spreadsheetId,
      range: sheet_categories,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[category_id, name, icon]] },
    });
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/categories', async (req, res) => {
  try {
    const records = await getRecords(sheet_categories);
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/update_category/:category_id', async (req, res) => {
  try {
    const category_id = req.params.category_id;
    const { name, icon } = req.body;
    const resData = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: sheet.spreadsheetId,
      range: sheet_categories,
    });

    const [headers, ...rows] = resData.data.values;
    const updated = rows.map(row => row[0] === category_id ? [category_id, name, icon] : row);

    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: sheet.spreadsheetId,
      range: sheet_categories,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [headers, ...updated]
      }
    });
    res.json({ status: 'updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/delete_category/:category_id', async (req, res) => {
  try {
    const category_id = req.params.category_id;

    const meta = await sheetsClient.spreadsheets.get({
      spreadsheetId: sheet.spreadsheetId
    });

    const sheetIdMap = {};
    meta.data.sheets.forEach(s => {
      sheetIdMap[s.properties.title] = s.properties.sheetId;
    });

    const catRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: sheet.spreadsheetId,
      range: sheet_categories,
    });

    const [catHeaders, ...catRows] = catRes.data.values || [];

    const catIndex = catRows.findIndex(row => row[0] === category_id);
    if (catIndex === -1) {
      return res.status(404).json({ error: 'Category not found' });
    }

    const deletedCat = catRows[catIndex];
    const category_name = deletedCat[1];

    await sheetsClient.spreadsheets.batchUpdate({
      spreadsheetId: sheet.spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: sheetIdMap[sheet_categories], // ใช้ชื่อเพื่อ map เป็น sheetId
                dimension: "ROWS",
                startIndex: catIndex + 1, // ข้าม header
                endIndex: catIndex + 2
              }
            }
          }
        ]
      }
    });

    const prodRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: sheet.spreadsheetId,
      range: sheet_basic,
    });

    const [prodHeaders, ...prodRows] = prodRes.data.values || [];
    const deleteIndexes = [];
    prodRows.forEach((row, i) => {
      if (row[2] === category_name) deleteIndexes.push(i + 1); // +1 เพราะ skip header
    });

    if (deleteIndexes.length > 0) {
      deleteIndexes.sort((a, b) => b - a);

      const deleteRequests = deleteIndexes.map(index => ({
        deleteDimension: {
          range: {
            sheetId: sheetIdMap[sheet_basic],
            dimension: "ROWS",
            startIndex: index,
            endIndex: index + 1
          }
        }
      }));

      await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId: sheet.spreadsheetId,
        requestBody: { requests: deleteRequests }
      });
    }

    res.json({ status: 'deleted', deletedProducts: deleteIndexes.length });

  } catch (err) {
    console.error('❌ Error deleting category:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/product_counts_by_category', async (req, res) => {
  try {
    const basic = await getRecords(sheet_basic);
    const pipe = await getRecords(sheet_pipes);
    const all = basic.concat(pipe);

    const counts = {};
    all.forEach(p => {
      const cat = p.category || 'Unknown';
      counts[cat] = (counts[cat] || 0) + 1;
    });

    res.json(counts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/basic_products', async (req, res) => {
  try {
    const page = parseInt(req.query.page || '1');
    const size = parseInt(req.query.size || '50');
    const category = req.query.category;

    const basic = await getRecords(sheet_basic);
    const pipe = await getRecords(sheet_pipes);
    const all = basic.concat(pipe);

    const withDesc = all.map((row) => {
      // ✅ เติม description หากไม่มี
      if (!row.description || !row.description.trim()) {
        row.description = [
          row.diameter && `Diameter: ${row.diameter}`,
          row.length && `Length: ${row.length}`,
          row.ptfeGrade && `PTFE Grade: ${row.ptfeGrade}`,
          row.coating && `Coating: ${row.coating}`,
          row.flange && `Flange: ${row.flange}`,
          row.ventHole && `Vent Hole: ${row.ventHole}`,
          row.grounding && `Grounding: ${row.grounding}`,
          row.vacuumRated && `Vacuum Rated: ${row.vacuumRated}`,
        ].filter(Boolean).join(', ');
      }

      // ✅ แปลง cost เป็นตัวเลข (หรือ fallback เป็น 0)
      row.cost = parseFloat(row.cost) || 0;

      return row;
    });

    const filtered = category
      ? withDesc.filter((p) => (p.category || '').toLowerCase() === category.toLowerCase())
      : withDesc;

    const paged = filtered.slice((page - 1) * size, page * size);

    res.json({ items: paged, total: filtered.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;

initSheets().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
});

app.post('/save_basic_product', async (req, res) => {
  try {
    const data = req.body;
    const categories = await getRecords(sheet_categories);
    const matched = categories.find(c => c.category_id.toLowerCase() === (data.category || '').toLowerCase());
    const category_name = matched ? matched.name : data.category;

    const newRow = [
      data.product_id || '',
      data.name || '',
      category_name || '',
      data.sub_category || '',
      data.description || '',
      data.price !== undefined ? data.price : '',
      data.image_url || '',
      data.cost !== undefined ? data.cost : ''
    ];

    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: sheet.spreadsheetId,
      range: sheet_basic,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [newRow] },
    });
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/update_product/:product_id', async (req, res) => {
  try {
    const product_id = req.params.product_id;
    const data = req.body;
    const is_pipe = (data.category || '').toLowerCase() === 'pipe';
    const targetSheet = is_pipe ? sheet_pipes : sheet_basic;

    const sheetData = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: sheet.spreadsheetId,
      range: targetSheet,
    });

    const [headers, ...rows] = sheetData.data.values;
    const match_id = is_pipe && product_id.startsWith('P') ? product_id.slice(1) : product_id;

    const updated = rows.map(row => {
      if (row[0] === match_id) {
        if (is_pipe) {
          // สร้างแถวใหม่โดยเช็คฟิลด์ที่เปลี่ยนเท่านั้น
          return [
            row[0], // product_id
            row[1], // name (Custom PTFE)
            row[2], // category
            data.price !== undefined && data.price !== row[3] ? String(data.price) : row[3],
            data.diameter !== undefined && data.diameter !== row[4] ? data.diameter : row[4],
            data.length !== undefined && data.length !== row[5] ? data.length : row[5],
            data.ptfeGrade !== undefined && data.ptfeGrade !== row[6] ? data.ptfeGrade : row[6],
            data.coating !== undefined && data.coating !== row[7] ? data.coating : row[7],
            data.flangeConfig !== undefined && data.flangeConfig !== row[8] ? data.flangeConfig : row[8],
            data.ventHole !== undefined ? (data.ventHole ? 'Yes' : 'No') : row[9],
            data.grounding !== undefined ? (data.grounding ? 'Yes' : 'No') : row[10],
            data.vacuumRated !== undefined ? (data.vacuumRated ? 'Yes' : 'No') : row[11],
            data.cost !== undefined && data.cost !== row[12] ? String(data.cost) : row[12]
          ];
        } else {
          // สำหรับสินค้าทั่วไป
          return [
            data.product_id || row[0],
            data.name !== undefined && data.name !== row[1] ? data.name : row[1],
            data.category || row[2],
            data.sub_category !== undefined && data.sub_category !== row[3] ? data.sub_category : row[3],
            data.description !== undefined && data.description !== row[4] ? data.description : row[4],
            data.price !== undefined && data.price !== row[5] ? String(data.price) : row[5],
            data.image_url !== undefined && data.image_url !== row[6] ? data.image_url : row[6],
            data.cost !== undefined && data.cost !== row[7] ? String(data.cost) : row[7]
          ];
        }
      } else {
        return row;
      }
    });

    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: sheet.spreadsheetId,
      range: targetSheet,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [headers, ...updated] },
    });
    res.json({ status: 'updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/delete_product/:product_id', async (req, res) => {
  try {
    const product_id = req.params.product_id;
    let deleted = false;

    // 1. โหลดข้อมูล metadata เพื่อ map ชื่อ -> sheetId
    const meta = await sheetsClient.spreadsheets.get({
      spreadsheetId: sheet.spreadsheetId
    });

    const sheetIdMap = {};
    meta.data.sheets.forEach(s => {
      sheetIdMap[s.properties.title] = s.properties.sheetId;
    });

    for (const sheetName of [sheet_basic, sheet_pipes]) {
      const isPipe = sheetName === sheet_pipes;
      const idToMatch = isPipe && product_id.startsWith('P') ? product_id.slice(1) : product_id;

      // 2. โหลดข้อมูลใน sheet นั้น
      const resData = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: sheet.spreadsheetId,
        range: `${sheetName}`,
      });

      const [headers, ...rows] = resData.data.values || [];

      // 3. หาแถวที่ตรงกับ product_id
      const rowIndex = rows.findIndex(r => r[0] === idToMatch);
      if (rowIndex === -1) continue; // ไม่เจอใน sheet นี้ → ข้าม

      // 4. ใช้ batchUpdate เพื่อลบแถวจริง
      await sheetsClient.spreadsheets.batchUpdate({
        spreadsheetId: sheet.spreadsheetId,
        requestBody: {
          requests: [
            {
              deleteDimension: {
                range: {
                  sheetId: sheetIdMap[sheetName],     // ต้องใช้เลข sheetId
                  dimension: 'ROWS',
                  startIndex: rowIndex + 1,  // +1 เพราะ row 0 คือ header
                  endIndex: rowIndex + 2
                }
              }
            }
          ]
        }
      });

      deleted = true;
    }

    if (deleted) {
      res.json({ status: 'deleted' });
    } else {
      res.status(404).json({ error: 'Product not found' });
    }
  } catch (err) {
    console.error('❌ Delete failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/add_pipe', async (req, res) => {
  try {
    const data = req.body;

    // ✅ สร้าง product_id แบบไม่ซ้ำด้วย timestamp + random
    const product_id = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    // ✅ สร้างแถวใหม่ที่จะบันทึก
    const newRow = [
      product_id,
      'Custom PTFE',
      'pipe',
      data.price || 200,
      data.diameter || '',
      data.length || '',
      data.ptfeGrade || '',
      data.coating || '',
      data.flangeConfig || '',
      data.ventHole ? 'Yes' : 'No',
      data.grounding ? 'Yes' : 'No',
      data.vacuumRated ? 'Yes' : 'No',
      data.cost !== undefined ? data.cost : ''
    ];

    // ✅ เพิ่มแถวลง Google Sheet
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: sheet.spreadsheetId,
      range: sheet_pipes,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: [newRow] },
    });

    res.json({ status: 'success', product_id });
  } catch (err) {
    console.error('❌ Error in /add_pipe:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/add_quotation', async (req, res) => {
  try {
    const data = req.body;

    const normalize = val => {
      if (val === undefined || val === null) return '';
      return String(val).replace(/^'/, '').trim().toLowerCase(); // ✅ ตัด ' ที่ใช้กันสูตร
    };

    const sanitize = val => {
      if (typeof val !== 'string') return val;
      if (val.trim().startsWith('=') || val.trim().startsWith('+')) {
        return `'${val}`;
      }
      return val;
    };

    const itemsRes = await getRecords(sheet_items);
    const customersRes = await getRecords(sheet_customers);

    let new_qno = '';
    let new_rev = 0;
    const issued_date = new Date().toLocaleDateString('en-GB');
    const status = "Pending";

    const base_no = data.quotation_no?.trim();
    const related_rows = base_no
      ? itemsRes.filter(r => r.quotation_no === base_no)
      : [];

    if (!base_no || related_rows.length === 0) {
      // ✅ สร้างใบเสนอราคาใหม่
      const now = new Date();
      const prefix = `QT${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}T-`;

      const existingNos = itemsRes
        .map(r => r.quotation_no)
        .filter(q => q.startsWith(prefix));

      const lastNo = existingNos.sort().pop();
      let nextNumber = 1;

      if (lastNo) {
        const match = lastNo.match(/(\d{4})$/);
        if (match) nextNumber = parseInt(match[1]) + 1;
      }

      new_qno = `${prefix}${String(nextNumber).padStart(4, '0')}`;
      new_rev = 0;

    } else {
      // ✅ เป็นการแก้ไขใบเสนอราคาเดิม
      new_qno = base_no;
      const existingRevs = related_rows
        .map(r => parseInt(r.rev || '0'))
        .filter(r => !isNaN(r));

      new_rev = existingRevs.length ? Math.max(...existingRevs) + 1 : 1;

      const latest_rows = related_rows.filter(r => parseInt(r.rev || '0') === new_rev - 1);
      const latest_customer_row = customersRes.find(
        r => r.quotation_no === base_no && String(r.rev || '0') === String(new_rev - 1)
      );

      const matches = data.items.map(item =>
        latest_rows.some(r =>
          normalize(r.product_id) === normalize(item.product_id) &&
          normalize(r.name) === normalize(item.name) &&
          String(r.price) === String(item.price) &&
          String(r.quantity) === String(item.quantity)
        )
      );

      function customerEqual(a, b) {
        const fields = [
          'customer_name', 'email', 'phone', 'company', 'address', 'notes',
          'sales_person', 'sales_mobile', 'sales_email', 'sales_contact',
          'contact_tel', 'contact_email', 'delivery_time', 'delivery_term',
          'payment_term', 'quotation_validity', 'customer_ref', 'enquiry_ref'
        ];
        return fields.every(f => normalize(a[f]) === normalize(b[f]));
      }

      const customerSame = latest_customer_row && customerEqual(data, latest_customer_row);

      if (
        matches.every(Boolean) &&
        latest_rows.length === data.items.length &&
        customerSame
      ) {
        return res.json({
          status: 'skipped',
          message: 'Duplicate quotation revision',
          quotation_no: new_qno,
          rev: new_rev - 1
        });
      }
    }

    // ✅ เพิ่ม item ลง Google Sheets พร้อม sanitize กันสูตร
    const itemValues = data.items.map(item => [
      new_qno,
      new_rev === 0 ? '' : new_rev,
      issued_date,
      status,
      sanitize(item.category),
      sanitize(item.product_id),
      sanitize(item.name),
      item.price,
      item.quantity,
      sanitize(item.description || ''),
      item.cost || 0
    ]);

    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: sheet.spreadsheetId,
      range: sheet_items,
      valueInputOption: 'USER_ENTERED',
      resource: { values: itemValues }
    });

    // ✅ เพิ่มข้อมูลลูกค้า ถ้ายังไม่มี rev นี้
    const alreadyHasCustomer = customersRes.some(row =>
      row.quotation_no === new_qno && String(row.rev || '0') === String(new_rev)
    );

    if (!alreadyHasCustomer) {
      const customerRow = [[
        new_qno,
        new_rev === 0 ? '' : new_rev,
        issued_date,
        status,
        sanitize(data.customer_name),
        sanitize(data.email),
        sanitize(data.phone),
        sanitize(data.company),
        sanitize(data.address),
        sanitize(data.notes),
        sanitize(data.sales_person),
        sanitize(data.sales_mobile),
        sanitize(data.sales_email),
        sanitize(data.sales_contact),
        sanitize(data.contact_tel),
        sanitize(data.contact_email),
        sanitize(data.delivery_time),
        sanitize(data.delivery_term),
        sanitize(data.payment_term),
        sanitize(data.quotation_validity),
        sanitize(data.customer_ref || ''),
        sanitize(data.enquiry_ref || '')
      ]];

      await sheetsClient.spreadsheets.values.append({
        spreadsheetId: sheet.spreadsheetId,
        range: sheet_customers,
        valueInputOption: 'USER_ENTERED',
        resource: { values: customerRow }
      });
    }

    res.json({ status: 'success', quotation_no: new_qno, rev: new_rev });
  } catch (err) {
    console.error('❌ Error saving quotation:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/quotation/:quotation_no', async (req, res) => {
  try {
    const quotation_no = req.params.quotation_no;
    const rev = req.query.rev;

    const items = await getRecords(sheet_items);
    const customers = await getRecords(sheet_customers);
    const drawings = await getRecords(sheet_dwg); // ✅ โหลด drawing จาก sheet 'dwg'

    // ✅ Filter รายการสินค้าจาก quotation_no + rev (ถ้ามี)
    const matched_items = items.filter(row => {
      const itemRev = row.rev ?? ''; // fallback เป็นช่องว่างถ้า undefined
      const revQuery = rev ?? '';    // fallback เช่นกัน

      return row.quotation_no === quotation_no &&
            String(itemRev).trim() === String(revQuery).trim();
    });

    if (!matched_items.length) {
      return res.status(404).json({ error: 'Quotation not found' });
    }

    // ✅ หา customer row ที่ตรงกับ quotation_no และ rev
    const customer = customers.find(row =>
      row.quotation_no === quotation_no &&
      String((row.rev ?? '').trim()) === String((rev ?? '').trim())
    ) || {};

    // ✅ เพิ่ม dwg เข้าไปในแต่ละรายการ item
    matched_items.forEach(item => {
      const dwgName = item.dwg?.trim();

      if (!dwgName) return;

      const matchedDrawing = drawings.find(d =>
        d.quotation_no === item.quotation_no &&
        String(d.rev || '') === String(item.rev || '') &&
        (d.drawing_name || '').trim() === dwgName
      );

      // ✅ ใส่ชื่อและลิงก์ dwg ลงในแต่ละ item
      item.dwg_name = matchedDrawing?.drawing_name || dwgName; // fallback เป็น dwg ในชีต1
      item.dwg_url = matchedDrawing?.drawing_url || '';         // ถ้ามี link ก็แนบไปด้วย
    });

    // ✅ ส่งข้อมูลกลับพร้อม issued_date และ status จาก item แถวแรก
    res.json({
      customer: {
        name: customer.customer_name || '',
        email: customer.email || '',
        phone: customer.phone || '',
        company: customer.company || '',
        address: customer.address || '',
        notes: customer.notes || '',
        sales_person: customer.sales_person || '',
        sales_mobile: customer.sales_mobile || '',
        sales_email: customer.sales_email || '',
        sales_contact: customer.sales_contact || '',
        contact_tel: customer.contact_tel || '',
        contact_email: customer.contact_email || '',
        delivery_time: customer.delivery_time || '',
        delivery_term: customer.delivery_term || '',
        payment_term: customer.payment_term || '',
        quotation_validity: customer.quotation_validity || '',
        customer_ref: customer.customer_ref || '',
        enquiry_ref: customer.enquiry_ref || ''
      },
      items: matched_items,
      issued_date: customer.issued_date || matched_items[0]?.issued_date || '',
      status: matched_items[0]?.status || ''
    });

  } catch (err) {
    console.error('❌ quotation API error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/quotation_list', async (req, res) => {
  try {
    const records = await getRecords(sheet_items);
    const statusFilter = (req.query.status || '').toLowerCase();

    const filtered = statusFilter
      ? records.filter(r => String(r.status || '').toLowerCase() === statusFilter)
      : records;

    const qnos = [...new Set(filtered.map(r => r.quotation_no).filter(Boolean))].sort();
    res.json(qnos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/latest_quotation_no', async (req, res) => {
  try {
    const prefix = req.query.prefix;
    const items = await getRecords(sheet_items);
    const matching = items.map(r => r.quotation_no)
                          .filter(q => q && q.startsWith(prefix));

    const last = matching.sort().pop(); // เช่น QT2506T-0003
    res.json({ last: last || '' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch latest quotation number' });
  }
});

app.get('/revisions/:quotation_no', async (req, res) => {
    try {
        const base = req.params.quotation_no;
        const items = await getRecords(sheet_items);
        const revs = items
            .filter(r => r.quotation_no === base)
            .map(r => parseInt(r.rev))
            .filter(r => !isNaN(r));

        const uniqueSorted = [...new Set(revs)].sort((a, b) => a - b);
        res.json(uniqueSorted);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/update_quotation_status', async (req, res) => {
  try {
    const { quotation_no, rev, status } = req.body;

    const sheet1 = sheet_items;
    const sheet2 = sheet_customers;

    const [res1, res2] = await Promise.all([
      sheetsClient.spreadsheets.values.get({
        spreadsheetId: sheet.spreadsheetId,
        range: sheet1,
      }),
      sheetsClient.spreadsheets.values.get({
        spreadsheetId: sheet.spreadsheetId,
        range: sheet2,
      }),
    ]);

    const [headers1, ...rows1] = res1.data.values;
    const [headers2, ...rows2] = res2.data.values;

    const updates1 = rows1
      .map((row, index) => ({ rowIndex: index, row }))
      .filter(obj => obj.row[0] === quotation_no && obj.row[1] === String(rev));

    const updateRequests = [];

    // ✅ อัปเดตเฉพาะคอลัมน์ D ใน sheet1 (ใบเสนอราคาหลัก)
    for (const u of updates1) {
      const targetRow = u.rowIndex + 2; // +2 เพราะ header อยู่บรรทัดที่ 1 และ index เริ่มจาก 0
      updateRequests.push(
        sheetsClient.spreadsheets.values.update({
          spreadsheetId: sheet.spreadsheetId,
          range: `${sheet1}!D${targetRow}`,
          valueInputOption: 'USER_ENTERED',
          resource: { values: [[status]] }
        })
      );
    }

    // ✅ อัปเดต sheet2 (ลูกค้า) เฉพาะแถวเดียว
    const rowIndex2 = rows2.findIndex(row => row[0] === quotation_no && row[1] === String(rev));
    if (rowIndex2 >= 0) {
      const targetRow2 = rowIndex2 + 2;
      updateRequests.push(
        sheetsClient.spreadsheets.values.update({
          spreadsheetId: sheet.spreadsheetId,
          range: `${sheet2}!D${targetRow2}`,
          valueInputOption: 'USER_ENTERED',
          resource: { values: [[status]] }
        })
      );
    }

    // ✅ รันคำสั่งทั้งหมดพร้อมกัน
    await Promise.all(updateRequests);

    res.json({ message: 'Status updated successfully in both sheets' });

  } catch (err) {
    console.error('❌ Failed to update quotation status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

//file dwg.
app.post('/upload_drawing', upload.array('files'), async (req, res) => {
  const files = req.files;
  const { quotation_no, rev } = req.body;

  if (!quotation_no || rev === undefined) {
    return res.status(400).json({ message: 'quotation_no and rev are required' });
  }

  if (!files || files.length === 0) {
    return res.status(400).json({ message: 'No files uploaded' });
  }

  const uploadedRows = [];

  for (const file of files) {
    const fileName = `${quotation_no}_Rev${rev}_${file.originalname}`;

    try {
      // ✅ อัปโหลดเข้า Google Drive
      const uploadRes = await drive.files.create({
        requestBody: {
          name: fileName,
          parents: ['0AMAMX2HShzTXUk9PVA'], // เปลี่ยนเป็น Folder ID จริงของคุณ
        },
        media: {
          mimeType: file.mimetype,
          body: fs.createReadStream(file.path),
        },
        supportsAllDrives: true,
      });

      const fileId = uploadRes.data.id;

      // ✅ แชร์ไฟล์ให้ anyone with the link สามารถดาวน์โหลดได้
      await drive.permissions.create({
        fileId,
        requestBody: {
          role: 'reader',
          type: 'anyone',
        },
        supportsAllDrives: true,
      });

      // ✅ สร้าง direct download URL
      const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

      uploadedRows.push([
        quotation_no,
        rev,
        file.originalname,
        downloadUrl
      ]);

      // ✅ ลบไฟล์ local
      fs.unlink(file.path, (err) => {
        if (err) console.error(`❌ ลบไฟล์ไม่สำเร็จ: ${file.path}`, err);
      });

    } catch (err) {
      console.error('❌ Error uploading file:', file.originalname, err);
      // clean up
      fs.unlink(file.path, (err) => {
        if (err) console.error(`❌ ลบไฟล์ไม่สำเร็จหลัง error: ${file.path}`, err);
      });
    }
  }

  // ✅ เขียนข้อมูลลง Google Sheet
  if (uploadedRows.length > 0) {
    try {
      await sheetsClient.spreadsheets.values.append({
        spreadsheetId: sheet.spreadsheetId,
        range: 'dwg!A:D',
        valueInputOption: 'USER_ENTERED',
        resource: { values: uploadedRows }
      });
    } catch (err) {
      console.error('❌ Error writing to sheet:', err);
      return res.status(500).json({ success: false, message: 'Upload complete but failed to write to sheet' });
    }
  }

  res.json({ success: true, uploaded: uploadedRows.length });
});

app.get('/drawing_files', async (req, res) => {
  const { quotation_no, rev } = req.query;

  try {
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: sheet.spreadsheetId,
      range: 'dwg!A2:D', // A: quotation_no, B: rev, C: drawing_name, D: drawing_url
    });

    const values = response.data.values || [];

    const allDrawings = values.map(row => ({
      quotation_no: row[0]?.trim(),
      rev: (row[1] || '').trim(), // ✅ fallback ช่องว่าง
      drawing_name: row[2],
      drawing_url: row[3]
    }));

    let filtered = allDrawings;

    if (quotation_no !== undefined) {
      const revNormalized = (rev || '').trim(); // "" ถ้าไม่มี Rev

      filtered = allDrawings.filter(d =>
        d.quotation_no === quotation_no &&
        (d.rev || '').trim() === revNormalized
      );
    }

    res.json(filtered);
  } catch (err) {
    console.error('❌ drawing_files error', err);
    res.status(500).json({ error: 'fetch failed' });
  }
});

app.post('/update_dwg_column', async (req, res) => {
  const { rows } = req.body; // [quotation_no, rev, product_id, drawing_name]

  try {
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: sheet.spreadsheetId,
      range: 'ชีต1!A2:L',
    });

    const sheetRows = response.data.values || [];

    for (const [quotation_no, rev, product_id, drawing_name] of rows) {
      const rowIndex = sheetRows.findIndex(row => {
        const sheetRev = row[1]?.trim() || '';
        const inputRev = String(rev).trim() || '';
        return (
          row[0] === quotation_no &&
          sheetRev === inputRev &&
          row[5] === product_id
        );
      });

      if (rowIndex !== -1) {
        const targetRow = rowIndex + 2;
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId: sheet.spreadsheetId,
          range: `ชีต1!L${targetRow}`,
          valueInputOption: 'USER_ENTERED',
          resource: { values: [[drawing_name]] }
        });
      }
    }

    res.json({ success: true, updated: rows.length });
  } catch (err) {
    console.error('❌ Failed to update DWG column:', err);
    res.status(500).json({ error: 'Update failed' });
  }
});

app.get('/company_lookup', async (req, res) => {
  const query = (req.query.query || '').trim().toLowerCase();
  if (!query) return res.status(400).json({ error: 'Missing query' });

  try {
    const customers = await getRecords(sheet_customer_master);
    const contacts = await getRecords('contact');

    const matched = customers.find(c =>
      (c.Name || '').toLowerCase().includes(query)
    );

    if (!matched) return res.status(404).json({ error: 'Company not found' });

    const customerNo = matched['No.']?.trim();
    const fullAddress = [
      matched.Address?.trim(),
      matched['Address 2']?.trim()
    ].filter(Boolean).join(' ');

    // ✅ หารายชื่อ contact ทั้งหมดที่ Company No. ตรงกับ customerNo
    const relatedContacts = contacts
      .filter(c => (c['Company No.'] || '').trim() === customerNo)
      .map(c => ({
        name: c['Name'] || '',
        phone: c['Phone No.'] || '',
        email: c['Email'] || ''
      }));

    res.json({
      company: matched.Name || '',
      companyNo: customerNo || '',
      address: fullAddress,
      contacts: relatedContacts
    });
  } catch (err) {
    console.error('❌ company_lookup error:', err);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

app.get('/sales_lookup_by_code', async (req, res) => {
  const code = (req.query.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Missing code' });

  try {
    const salesSheet = await getRecords('sale');

    const saleRow = salesSheet.find(row => row.Code === code);
    if (!saleRow) return res.status(404).json({ error: 'Sale code not found' });

    res.json({
      salesPerson: saleRow['Full Name'] || '',
      salesMobile: saleRow['Phone No.'] || ''
    });
  } catch (err) {
    console.error('❌ sales_lookup_by_code error:', err);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

app.get('/contact_lookup_by_code', async (req, res) => {
  const code = (req.query.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Missing code' });

  try {
    const contactSheet = await getRecords('sale');

    const contactRow = contactSheet.find(row => row.Code === code);
    if (!contactRow) return res.status(404).json({ error: 'Contact code not found' });

    res.json({
      contactPerson: contactRow['Full Name'] || '',
      contactTel: contactRow['Phone No.'] || ''
    });
  } catch (err) {
    console.error('❌ contact_lookup_by_code error:', err);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

app.post('/upload_excel', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;

    if (!file || !file.originalname.endsWith('.xlsx')) {
      return res.status(400).json({ message: 'ต้องเป็นไฟล์ Excel (.xlsx)' });
    }

    const originalName = file.originalname;

    // ✅ ตรวจสอบวันที่ในชื่อไฟล์
    const dateMatch = originalName.match(/(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) {
      return res.status(400).json({ message: 'ชื่อไฟล์ต้องมีวันที่ในรูปแบบ YYYY-MM-DD' });
    }

    const fileDateStr = dateMatch[1];

    const offset = new Date(Date.now() + (7 * 60 * 60 * 1000)); // เวลาไทย
    const yyyy = offset.getFullYear();
    const mm = String(offset.getMonth() + 1).padStart(2, '0');
    const dd = String(offset.getDate()).padStart(2, '0');
    const todayStr = `${yyyy}-${mm}-${dd}`;

    if (fileDateStr !== todayStr) {
      return res.status(400).json({ message: `วันที่ในชื่อไฟล์ต้องเป็นวันปัจจุบัน (${todayStr}) เท่านั้น` });
    }

    // ✅ ตรวจสอบชื่อไฟล์และเลือก sheet
    let targetSheet = null;

    if (originalName.startsWith('Customer List')) {
      targetSheet = sheet_customer_master;
    } else if (originalName.startsWith('Salespersons_Purchasers PURCHASE.MWAVE')) {
      targetSheet = 'sale';
    } else if (originalName.startsWith('Contact List PURCHASE.MWAVE')) {
      targetSheet = 'contact';
    } else {
      return res.status(400).json({
        message: 'ชื่อไฟล์ไม่ถูกต้อง ต้องขึ้นต้นด้วย "Customer List", "Salespersons_Purchasers PURCHASE.MWAVE", หรือ "Contact List PURCHASE.MWAVE"'
      });
    }

    // ✅ อ่าน Excel แบบปลอดภัย
    const workbook = xlsx.readFile(file.path);
    const sheetName = workbook.SheetNames[0];

    const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], {
      defval: '',
      raw: false // ดึงค่าที่แสดง ไม่ใช่สูตร
    });

    if (data.length === 0) {
      return res.status(400).json({ message: 'ไม่มีข้อมูลในไฟล์ Excel' });
    }

    // ✅ ป้องกันสูตรกลายเป็นสูตรใน Google Sheets
    const sanitizeValue = (val) => {
      if (typeof val !== 'string') return val;
      if (val.trim().startsWith('=') || val.trim().startsWith('+')) {
        return `'${val}`; // ป้องกันเป็นสูตร
      }
      return val;
    };

    const formatted = data.map(row =>
      Object.values(row).map(cell => sanitizeValue(cell))
    );

    // ✅ ล้างข้อมูลเดิม
    await sheetsClient.spreadsheets.values.clear({
      spreadsheetId: sheet.spreadsheetId,
      range: `${targetSheet}!A2:Z`
    });

    // ✅ เพิ่มข้อมูลใหม่
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: sheet.spreadsheetId,
      range: `${targetSheet}!A2`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        values: formatted
      }
    });

    res.json({ status: 'success', sheet: targetSheet, count: formatted.length });

  } catch (err) {
    console.error('❌ upload_excel error:', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดระหว่างอัปโหลด' });
  } finally {
    // ✅ ลบไฟล์ที่อัปโหลดออกจาก temp
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.get('/', (req, res) => {
  res.render('index'); 
});

app.get('/login', (req, res) => {
  res.render('login'); 
});

app.get('/add-pipe', (req, res) => {
  res.render('add-pipe'); 
});


