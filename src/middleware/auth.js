const API_KEY = process.env.API_KEY || 'default-secret-key';

const authMiddleware = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

    if (!apiKey || apiKey !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    next();
};

module.exports = { authMiddleware };
