-- 初始化 (/api/setup) 從未成功完成，資料庫中沒有任何管理員帳號；
-- 以註冊頁建立的 "admin" / "Admin" 帳號因此只有學員 (user) 角色，登入後會進到學員畫面。
-- 僅在目前完全沒有管理員時，將這兩個帳號升級為管理員，密碼維持不變。
UPDATE users
SET role = 'admin', status = 'active'
WHERE id IN (2, 9)
  AND lower(username) = 'admin'
  AND role = 'user'
  AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin');
