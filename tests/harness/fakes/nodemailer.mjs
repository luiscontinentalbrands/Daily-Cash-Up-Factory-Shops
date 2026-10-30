// Stand-in for nodemailer: records what would be sent instead of sending it.
const out = (globalThis.__fakeOut ||= { init: null, writes: [], mails: [], transports: [] });
export default {
  createTransport(opts) {
    out.transports.push(opts);
    return {
      async sendMail(m) {
        out.mails.push({ ...m, attachments: (m.attachments || []).map(a => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.content).toString("utf8") })) });
        return { messageId: "fake" };
      },
    };
  },
};
