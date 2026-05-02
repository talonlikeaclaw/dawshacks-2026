async function loadConversation() {
    const logsDiv = document.getElementById('logs');

    try {
        const response = await fetch('/api/conversations');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        const conversations = Array.isArray(data) ? data : [];
        logsDiv.textContent = '';

        if (conversations.length === 0) {
            logsDiv.textContent = 'No conversations yet.';
            return;
        }

        const table = document.createElement('table');
        table.className = 'conversation-table';
        table.innerHTML = `
            <thead>
                <tr>
                    <th>Time</th>
                    <th>Phone</th>
                    <th>Direction</th>
                    <th>Status</th>
                    <th>Message</th>
                </tr>
            </thead>
            <tbody></tbody>
        `;

        const tbody = table.querySelector('tbody');
        const sortedConversations = conversations.slice().sort((a, b) => {
            return new Date(a.time) - new Date(b.time);
        });
        const limitedConversations = sortedConversations.slice(0, 50);
        limitedConversations.forEach(conv => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${new Date(conv.time).toLocaleString()}</td>
                <td>${conv.phone}</td>
                <td>${conv.direction}</td>
                <td>${conv.status}</td>
                <td>${conv.body}</td>
            `;
            tbody.appendChild(row);
        });

        logsDiv.appendChild(table);
    } catch (error) {
        console.error('Error loading conversations:', error);
        logsDiv.textContent = 'Error loading conversations. Check the console for details.';
    }
}

document.addEventListener('DOMContentLoaded', loadConversation);