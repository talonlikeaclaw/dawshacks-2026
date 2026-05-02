function loadConversation() {
    const logsDiv = document.getElementById('logs');

    fetch('/api/conversations')
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            const conversations = data.conversations || [];
            logsDiv.textContent = ' ';

            if (conversations.length === 0) {
                logsDiv.textContent = 'No conversations yet.';
                return;
            }

            conversations.forEach(conv => {
                const convDiv = document.createElement('div');
                convDiv.className = 'conversation';
                convDiv.textContent = `${new Date(conv.time).toLocaleString()} - ${conv.phone} (${conv.direction}) ${conv.status}`;
                logsDiv.appendChild(convDiv);
            });
        })
        .catch(error => {
            console.error('Error loading conversations:', error);
            logsDiv.textContent = 'Error loading conversations. Check the console for details.';
        });
}

document.addEventListener('DOMContentLoaded', loadConversation);