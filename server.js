const express = require('express');
const bodyParser = require('body-parser');
const { initWhatsApp } = require('./whatsapp');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get('/', (_req, res) => res.send('BRYNIX WhatsApp Bot up ✅'));

initWhatsApp(app);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Servidor rodando na porta ${port}`));
