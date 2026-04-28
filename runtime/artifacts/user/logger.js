export default {
    id: 'logger',
    version: '1.0.0',
    artifactType: 'graph',
    sourceType: 'text/x-ndl',
    metadata: { name: 'Logger Workflow', description: 'template → console log', tags: ['user', 'log'] },
    source: `
graph logger @version:1.0.0
node templateNode @template
  state template = "User {{name}} (ID: {{id}}) performed an action at {{ts}}."
node logNode @log-process
templateNode.result -> logNode.msg
    `,
    interface: {
        inputs: { name: { type: 'string' }, id: { type: 'string' }, ts: { type: 'string' } },
        outputs: { logged: { type: 'boolean' }, msg: { type: 'string' } }
    }
};
