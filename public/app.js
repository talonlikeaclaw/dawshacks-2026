function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTime(isoString) {
  return new Date(isoString).toLocaleTimeString();
}

function statusColor(status) {
  if (status === "success") return "#10b981";
  if (status === "rate-limited") return "#f59e0b";
  return "#ef4444";
}

function renderRows(conversations) {
  if (!conversations.length) {
    return '<tr><td colspan="4" class="empty">No messages yet. Text the Twilio number to start!</td></tr>';
  }

  return conversations
    .map((conversation) => {
      const dirIcon = conversation.direction === "inbound" ? "📥" : "📤";
      return `
        <tr>
          <td class="time">${formatTime(conversation.time)}</td>
          <td class="phone">${conversation.phone}</td>
          <td class="message">${dirIcon} ${escapeHtml(conversation.body)}</td>
          <td>
            <span class="status-pill" style="background:${statusColor(conversation.status)};">${conversation.status}</span>
          </td>
        </tr>
      `;
    })
    .join("");
}

async function loadStatus() {
  const response = await fetch("/api/status");
  const data = await response.json();

  document.getElementById("totalMessages").textContent = String(data.totalMessages);
  document.getElementById("rateLimit").textContent = `${data.rateLimitSeconds}s`;
  document.getElementById("conversationRows").innerHTML = renderRows(data.conversations);
}

loadStatus();
setInterval(loadStatus, 3000);