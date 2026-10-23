-- 密碼輸錯的紀錄，用來限制同一個 IP 短時間內一直猜密碼
CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL -- Unix 秒
);

CREATE INDEX idx_login_attempts_ip_ts ON login_attempts (ip, ts);
