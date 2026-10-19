async function readAuthResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("網站存取保護阻擋了請求，請先使用有專案權限的 Netlify 帳號通過存取驗證，再回到網站登入。這不是 ProFit Health 的帳密錯誤。");
    }
    throw new Error(`伺服器未回傳帳號服務資料（HTTP ${response.status}），請聯絡網站管理員。`);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("帳號服務回應格式不正確，請稍後再試或聯絡網站管理員。");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("帳號服務回應格式不正確，請稍後再試或聯絡網站管理員。");
  }
  return data;
}
