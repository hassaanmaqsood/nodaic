/** log-process — logs message to console */
export default {
    id: 'log-process',
    version: '1.0.0',
    artifactType: 'process',
    sourceType: 'text/javascript',
    metadata: { name: 'Console Log', description: 'Logs message to console', tags: ['core', 'utility'] },
    source: `
        console.log(\`[workflow-logger] \${input.msg || input.data || JSON.stringify(input)}\`);
        returnCallback({ output: { logged: true, msg: input.msg }, state });
    `,
    interface: {
        inputs:  { msg: { type: 'string' }, data: { type: 'any' } },
        outputs: { logged: { type: 'boolean' }, msg: { type: 'string' } }
    }
};
