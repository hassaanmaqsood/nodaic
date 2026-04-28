export default {
    id: 'whatsapp-pipeline',
    version: '1.0.0',
    artifactType: 'graph',
    sourceType: 'text/x-ndl',
    metadata: { name: 'WhatsApp Automation Pipeline', description: 'whatsapp-router → whatsapp-responder', tags: ['whatsapp', 'pipeline', 'automation'] },
    source: `
graph whatsapp-pipeline @version:1.0.0
node router @whatsapp-router
node responder @whatsapp-responder
router.from -> responder.from
router.body -> responder.body
router.intent -> responder.intent
router.confidence -> responder.confidence
    `,
    interface: {
        inputs: { from: { type: 'string' }, body: { type: 'string' } },
        outputs: { from: { type: 'string' }, reply: { type: 'string' }, intent: { type: 'string' }, channel: { type: 'string' }, ts: { type: 'number' } }
    }
};
