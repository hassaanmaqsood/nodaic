export default {
    id: 'whatsapp-responder',
    version: '1.0.0',
    artifactType: 'process',
    sourceType: 'text/javascript',
    metadata: { name: 'WhatsApp Responder', description: 'Generates reply messages based on intent', tags: ['whatsapp', 'response', 'automation'] },
    source: `
        const { from, intent, body } = input;

        const replies = {
            greeting: 'Hello! 👋 Welcome to Nodaic Support. How can I help you today?',
            order: '📦 Sure! Please share your order number and I\\'ll look up the status for you.',
            support: '🛠️ I\\'m sorry to hear you\\'re having trouble. Let me connect you with our support team.',
            billing: '💳 For billing inquiries, I can help you with plans, payments, and invoices.',
            cancel: '⚠️ I understand you\\'d like to cancel. Let me pull up your account. Can you confirm your email?',
            unknown: 'Thanks for reaching out! I\\'m not sure I understood that. Could you rephrase or type "help" for options?'
        };

        const reply = replies[intent] || replies.unknown;

        console.log(\`[whatsapp-responder] → \${from}: "\${reply.substring(0, 50)}..."\`);
        returnCallback({
            output: { from, reply, intent, channel: 'whatsapp', ts: Date.now() },
            state
        });
    `,
    interface: {
        inputs: { from: { type: 'string', required: true }, intent: { type: 'string', required: true }, body: { type: 'string' } },
        outputs: { from: { type: 'string' }, reply: { type: 'string' }, intent: { type: 'string' }, channel: { type: 'string' }, ts: { type: 'number' } }
    }
};
