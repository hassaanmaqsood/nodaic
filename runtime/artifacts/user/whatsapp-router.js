export default {
    id: 'whatsapp-router',
    version: '1.0.0',
    artifactType: 'process',
    sourceType: 'text/javascript',
    metadata: { name: 'WhatsApp Router', description: 'Classifies WhatsApp messages by intent', tags: ['whatsapp', 'routing', 'automation'] },
    source: `
        const { from = '', body = '' } = input;
        const lower = body.toLowerCase().trim();

        let intent = 'unknown';
        let confidence = 0.5;

        if (/^(hi|hello|hey|assalam|salam|good\\s?(morning|evening|afternoon))/.test(lower)) {
            intent = 'greeting'; confidence = 0.95;
        } else if (/order|status|track|delivery|shipment|shipped/.test(lower)) {
            intent = 'order'; confidence = 0.9;
        } else if (/help|support|issue|problem|bug|broken|fix/.test(lower)) {
            intent = 'support'; confidence = 0.9;
        } else if (/price|cost|plan|subscribe|payment|pay|bill/.test(lower)) {
            intent = 'billing'; confidence = 0.85;
        } else if (/cancel|unsubscribe|stop|remove|delete/.test(lower)) {
            intent = 'cancel'; confidence = 0.85;
        }

        const result = { from, body, intent, confidence, ts: Date.now() };

        if (state._emit) {
            state._emit(\`whatsapp:intent:\${intent}\`, result);
        }

        console.log(\`[whatsapp-router] \${from} → intent=\${intent} (\${confidence})\`);
        returnCallback({ output: result, state });
    `,
    interface: {
        inputs: { from: { type: 'string' }, body: { type: 'string' } },
        outputs: { from: { type: 'string' }, body: { type: 'string' }, intent: { type: 'string' }, confidence: { type: 'number' }, ts: { type: 'number' } }
    }
};
