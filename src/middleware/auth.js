const adminAuth = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey && apiKey === process.env.ADMIN_API_KEY) next();
  else res.status(401).json({ error: "Unauthorized: Sai API Key." });
};

const userAuth = (req, res, next) => {
  const userId = req.headers["x-user-id"];
  if (userId && !isNaN(parseInt(userId, 10))) {
    req.user_id = parseInt(userId, 10);
    next();
  } else {
    res.status(401).json({ error: "Unauthorized: Thiếu hoặc sai x-user-id header." });
  }
};

module.exports = {
  adminAuth,
  userAuth,
};
