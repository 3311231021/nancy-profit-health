// 綠界 ECPay：全方位金流（AIO 信用卡）與 B2C 電子發票
// 未設定環境變數時使用綠界官方文件公開的「測試環境」特店資料，只能在 stage 測試環境使用。
const crypto = require("node:crypto");

const production = process.env.ECPAY_MODE === "production";

const payment = {
  merchantId: process.env.ECPAY_MERCHANT_ID || (production ? "" : "3002607"),
  hashKey: process.env.ECPAY_HASH_KEY || (production ? "" : "pwFHCqoQZGmho4w6"),
  hashIv: process.env.ECPAY_HASH_IV || (production ? "" : "EkRm7iFT261dpevs"),
  checkoutUrl: production
    ? "https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5"
    : "https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5",
  queryUrl: production
    ? "https://payment.ecpay.com.tw/Cashier/QueryTradeInfo/V5"
    : "https://payment-stage.ecpay.com.tw/Cashier/QueryTradeInfo/V5",
};

const invoice = {
  merchantId: process.env.ECPAY_INVOICE_MERCHANT_ID || (production ? "" : "2000132"),
  hashKey: process.env.ECPAY_INVOICE_HASH_KEY || (production ? "" : "ejCk326UnaZWKisg"),
  hashIv: process.env.ECPAY_INVOICE_HASH_IV || (production ? "" : "q9jcZX8Ib9LM8wYk"),
  baseUrl: production ? "https://einvoice.ecpay.com.tw" : "https://einvoice-stage.ecpay.com.tw",
};

// 綠界規定的 .NET 風格 URL encode（空白為 +、保留 -_.!*()，全部轉小寫）
function dotnetUrlEncode(s) {
  return encodeURIComponent(s).replace(/%20/g, "+").replace(/'/g, "%27").replace(/~/g, "%7e").toLowerCase();
}

function checkMacValue(params, cfg = payment) {
  const keys = Object.keys(params)
    .filter((k) => k !== "CheckMacValue")
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
  const raw = `HashKey=${cfg.hashKey}&${keys.map((k) => `${k}=${params[k]}`).join("&")}&HashIV=${cfg.hashIv}`;
  return crypto.createHash("sha256").update(dotnetUrlEncode(raw)).digest("hex").toUpperCase();
}

function verifyCheckMac(params) {
  const given = String(params.CheckMacValue || "");
  const expected = checkMacValue(params);
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

// yyyy/MM/dd HH:mm:ss（台北時間）
function taipeiDateTime(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(d).map((x) => [x.type, x.value])
  );
  return `${p.year}/${p.month}/${p.day} ${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}`;
}

function newTradeNo() {
  // 綠界限制 20 碼英數字
  return ("PF" + Date.now().toString(36) + crypto.randomBytes(6).toString("hex")).toUpperCase().slice(0, 20);
}

function cleanText(s, max) {
  // 綠界參數不接受部分特殊字元，避免 CheckMacValue 或表單被截斷
  return String(s || "").replace(/[#&+<>'"%\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function buildCheckout({ tradeNo, amount, itemName, tradeDesc, returnUrl, clientBackUrl }) {
  const fields = {
    MerchantID: payment.merchantId,
    MerchantTradeNo: tradeNo,
    MerchantTradeDate: taipeiDateTime(),
    PaymentType: "aio",
    TotalAmount: String(amount),
    TradeDesc: cleanText(tradeDesc, 200) || "ProFit Health",
    ItemName: cleanText(itemName, 200) || "課程",
    ReturnURL: returnUrl,
    ClientBackURL: clientBackUrl,
    ChoosePayment: "Credit",
    EncryptType: "1",
    NeedExtraPaidInfo: "N",
  };
  fields.CheckMacValue = checkMacValue(fields);
  return { action: payment.checkoutUrl, fields };
}

async function queryTrade(tradeNo) {
  const params = { MerchantID: payment.merchantId, MerchantTradeNo: tradeNo, TimeStamp: String(Math.floor(Date.now() / 1000)) };
  params.CheckMacValue = checkMacValue(params);
  const res = await fetch(payment.queryUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(8000),
  });
  const data = Object.fromEntries(new URLSearchParams(await res.text()));
  if (!verifyCheckMac(data)) throw new Error("綠界查詢回應驗證失敗");
  return data;
}

// ---------------- 電子發票 ----------------
function aesEncrypt(obj) {
  const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(invoice.hashKey), Buffer.from(invoice.hashIv));
  return Buffer.concat([cipher.update(encodeURIComponent(JSON.stringify(obj)), "utf8"), cipher.final()]).toString("base64");
}

function aesDecrypt(b64) {
  const decipher = crypto.createDecipheriv("aes-128-cbc", Buffer.from(invoice.hashKey), Buffer.from(invoice.hashIv));
  const text = Buffer.concat([decipher.update(Buffer.from(b64, "base64")), decipher.final()]).toString("utf8");
  return JSON.parse(decodeURIComponent(text.replace(/\+/g, " ")));
}

async function invoiceCall(path, data) {
  const res = await fetch(invoice.baseUrl + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      MerchantID: invoice.merchantId,
      RqHeader: { Timestamp: Math.floor(Date.now() / 1000) },
      Data: aesEncrypt({ MerchantID: invoice.merchantId, ...data }),
    }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.json();
  if (Number(body.TransCode) !== 1 || !body.Data) throw new Error(`發票服務錯誤：${body.TransMsg || res.status}`);
  return aesDecrypt(body.Data);
}

// order: { relateNumber, amount, itemName, itemWord, customerName, customerEmail, invoice_type, carrier_num, love_code, company_* }
async function issueInvoice(o) {
  const data = {
    RelateNumber: o.relateNumber,
    CustomerID: "",
    CustomerIdentifier: "",
    CustomerName: cleanText(o.customerName, 60),
    CustomerAddr: "",
    CustomerPhone: "",
    CustomerEmail: o.customerEmail,
    ClearanceMark: "",
    Print: "0",
    Donation: "0",
    LoveCode: "",
    CarrierType: "",
    CarrierNum: "",
    TaxType: "1",
    SalesAmount: o.amount,
    InvoiceRemark: "ProFit Health 課程",
    InvType: "07",
    vat: "1",
    Items: [{
      ItemSeq: 1,
      ItemName: cleanText(o.itemName, 100),
      ItemCount: 1,
      ItemWord: o.itemWord || "式",
      ItemPrice: o.amount,
      ItemTaxType: "1",
      ItemAmount: o.amount,
      ItemRemark: "",
    }],
  };
  if (o.invoice_type === "company") {
    Object.assign(data, { CustomerIdentifier: o.company_tax_id, CustomerName: cleanText(o.company_name, 60), CustomerAddr: cleanText(o.company_address, 100), Print: "1" });
  } else if (o.invoice_type === "donation") {
    Object.assign(data, { Donation: "1", LoveCode: o.love_code });
  } else if (o.invoice_type === "mobile") {
    Object.assign(data, { CarrierType: "3", CarrierNum: o.carrier_num });
  } else {
    Object.assign(data, { CarrierType: "1" });
  }
  const r = await invoiceCall("/B2CInvoice/Issue", data);
  if (Number(r.RtnCode) !== 1) throw new Error(r.RtnMsg || "發票開立失敗");
  return { invoiceNo: r.InvoiceNo, invoiceDate: r.InvoiceDate, randomNumber: r.RandomNumber };
}

async function voidInvoice({ invoiceNo, invoiceDate, reason }) {
  const r = await invoiceCall("/B2CInvoice/Invalid", { InvoiceNo: invoiceNo, InvoiceDate: String(invoiceDate).slice(0, 10), Reason: cleanText(reason, 20) || "退款" });
  if (Number(r.RtnCode) !== 1) throw new Error(r.RtnMsg || "發票作廢失敗");
}

// ---------------- 字軌與配號 ----------------
// 綠界規定年度一律為民國年 3 碼；期別 1~6 代表 1-2 月 … 11-12 月
function rocYear(d = new Date()) {
  return String(Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric" }).format(d)) - 1911);
}

// 綠界文件的回應範例有時把 InvoiceInfo 寫成物件，這裡統一成陣列
const asList = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : []);

async function wordCall(path, data, label) {
  const r = await invoiceCall(path, data);
  if (Number(r.RtnCode) !== 1) throw new Error(r.RtnMsg || label);
  return r;
}

async function listInvoiceWords({ year, term = 0, useStatus = 0 }) {
  const r = await invoiceCall("/B2CInvoice/GetInvoiceWordSetting", {
    InvoiceYear: year, InvoiceTerm: term, UseStatus: useStatus, InvoiceCategory: 1,
  });
  // 查無資料時綠界也會回傳非 1 的 RtnCode
  if (Number(r.RtnCode) !== 1) return { words: [], message: r.RtnMsg || "" };
  return { words: asList(r.InvoiceInfo), message: "" };
}

async function listGovInvoiceWords(year) {
  const r = await invoiceCall("/B2CInvoice/GetGovInvoiceWordSetting", { InvoiceYear: year });
  if (Number(r.RtnCode) !== 1) return { words: [], message: r.RtnMsg || "" };
  return { words: asList(r.InvoiceInfo), message: "" };
}

async function addInvoiceWord({ year, term, invType, header, start, end }) {
  const r = await wordCall("/B2CInvoice/AddInvoiceWordSetting", {
    InvoiceTerm: term, InvoiceYear: year, InvType: invType, InvoiceCategory: "1",
    InvoiceHeader: header, InvoiceStart: start, InvoiceEnd: end,
  }, "字軌新增失敗");
  return { trackId: r.TrackID };
}

async function updateInvoiceWordStatus(trackId, status) {
  await wordCall("/B2CInvoice/UpdateInvoiceWordStatus", { TrackID: trackId, InvoiceStatus: status }, "字軌狀態設定失敗");
}

module.exports = {
  production,
  configured: () => Boolean(payment.merchantId && payment.hashKey && payment.hashIv),
  invoiceConfigured: () => Boolean(invoice.merchantId && invoice.hashKey && invoice.hashIv),
  checkMacValue, verifyCheckMac, buildCheckout, queryTrade, newTradeNo, issueInvoice, voidInvoice,
  rocYear, listInvoiceWords, listGovInvoiceWords, addInvoiceWord, updateInvoiceWordStatus,
};
