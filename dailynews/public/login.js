const form = document.getElementById("login-form");
const input = document.getElementById("password");
const errorBox = document.getElementById("error");
const button = form.querySelector("button");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.textContent = "";
  button.disabled = true;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: input.value }),
    });
    if (res.ok) {
      location.replace("/");
      return;
    }
    const data = await res.json().catch(() => ({}));
    errorBox.textContent = data.error || "登入失敗，請再試一次。";
    input.select();
  } catch {
    errorBox.textContent = "連不上網站，請檢查網路後再試。";
  } finally {
    button.disabled = false;
  }
});
