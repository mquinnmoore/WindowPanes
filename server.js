const express = require('express');
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');

const app = express();
const PORT = process.env.PORT || 3000;
const CONFIG_PATH = process.env.CONFIG || path.join(__dirname, 'config.yaml');
const MEDIA_DIR = process.env.MEDIA_DIR || '/media';

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Serve media files (videos, images, etc.)
app.use('/media', express.static(MEDIA_DIR, {
  // Allow range requests for video seeking
  acceptRanges: true
}));

// API: return parsed config as JSON
app.get('/api/config', (req, res) => {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const config = yaml.load(raw);
    res.json(config);
  } catch (err) {
    console.error('Failed to load config:', err.message);
    res.status(500).json({ error: 'Failed to load config', detail: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`WindowPanes server running at http://localhost:${PORT}`);
  console.log(`Config: ${CONFIG_PATH}`);
  console.log(`Media dir: ${MEDIA_DIR}`);
});
