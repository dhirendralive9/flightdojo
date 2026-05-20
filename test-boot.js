(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  console.log('Started in-memory Mongo:', uri);
  process.env.MONGODB_URI = uri;
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'test@example.com';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'testpassword123';
  process.env.BOOTSTRAP_ADMIN_ROLE = 'owner';
  require('./app');
})();
