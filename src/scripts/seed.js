// src/scripts/seed.js
import mongoose from 'mongoose';
import { faker } from '@faker-js/faker';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../../.env') });

// Import models (these would be created in their respective module folders)
// For now, we'll define simple schemas here
const UserSchema = new mongoose.Schema({
  email: String,
  phoneNumber: String,
  password: String,
  profile: {
    firstName: String,
    lastName: String,
    displayName: String,
    dateOfBirth: Date,
    bio: String,
    gender: String,
    sexualOrientation: [String],
    location: {
      type: { type: String, default: 'Point' },
      coordinates: [Number], // [longitude, latitude]
      address: {
        city: String,
        state: String,
        country: String,
      },
    },
    photos: [{
      url: String,
      thumbnailUrl: String,
      order: Number,
      isMain: Boolean,
      isVerified: Boolean,
      uploadedAt: Date,
    }],
    height: Number,
    interests: [String],
    lifestyle: {
      drinking: String,
      smoking: String,
      workout: String,
      pets: [String],
      children: String,
    },
    education: {
      level: String,
      school: String,
      major: String,
    },
    career: {
      jobTitle: String,
      company: String,
    },
  },
  preferences: {
    ageRange: {
      min: Number,
      max: Number,
    },
    maxDistance: Number,
    genderPreference: [String],
    showMe: Boolean,
  },
  subscription: {
    type: String,
    validUntil: Date,
  },
  verification: {
    email: {
      verified: Boolean,
      verifiedAt: Date,
    },
    phone: {
      verified: Boolean,
      verifiedAt: Date,
    },
  },
  scoring: {
    eloScore: Number,
    activityScore: Number,
    profileCompleteness: Number,
  },
  status: {
    isActive: Boolean,
    isOnline: Boolean,
    lastActive: Date,
  },
  createdAt: Date,
  updatedAt: Date,
});

const SwipeSchema = new mongoose.Schema({
  from: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  to: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  action: String,
  swipedAt: Date,
  isActive: Boolean,
});

const MatchSchema = new mongoose.Schema({
  users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  matchedAt: Date,
  status: {
    isActive: Boolean,
  },
  interaction: {
    lastMessageAt: Date,
    messageCount: Number,
  },
});

const MessageSchema = new mongoose.Schema({
  matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Match' },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  content: {
    type: String,
    text: String,
  },
  status: {
    delivered: Boolean,
    read: Boolean,
  },
  sentAt: Date,
});

// Create models
const User = mongoose.model('User', UserSchema);
const Swipe = mongoose.model('Swipe', SwipeSchema);
const Match = mongoose.model('Match', MatchSchema);
const Message = mongoose.model('Message', MessageSchema);

// Seed data configuration
const SEED_CONFIG = {
  users: parseInt(process.env.SEED_USERS) || 100,
  matchesPerUser: parseInt(process.env.SEED_MATCHES_PER_USER) || 5,
  messagesPerMatch: parseInt(process.env.SEED_MESSAGES_PER_MATCH) || 10,
  swipesPerUser: parseInt(process.env.SEED_SWIPES_PER_USER) || 50,
};

// Data constants
const INTERESTS = [
  'Travel', 'Photography', 'Music', 'Cooking', 'Reading',
  'Fitness', 'Yoga', 'Running', 'Hiking', 'Camping',
  'Movies', 'Gaming', 'Art', 'Dancing', 'Writing',
  'Coffee', 'Wine', 'Food', 'Technology', 'Nature',
  'Pets', 'Fashion', 'Sports', 'Adventure', 'Beach',
];

const BIOS = [
  'Living my best life 🌟',
  'Adventure seeker and coffee lover ☕',
  'Looking for my partner in crime',
  'Foodie | Traveler | Dreamer',
  'Just a small town person living in a big city',
  'Sarcasm is my second language',
  'Dog parent 🐕 | Wine enthusiast 🍷',
  'Gym rat by day, Netflix addict by night',
  'Wanderlust infected ✈️',
  'Making memories around the world',
];

const CITIES = [
  { city: 'New York', state: 'NY', country: 'USA', lat: 40.7128, lng: -74.0060 },
  { city: 'Los Angeles', state: 'CA', country: 'USA', lat: 34.0522, lng: -118.2437 },
  { city: 'Chicago', state: 'IL', country: 'USA', lat: 41.8781, lng: -87.6298 },
  { city: 'Houston', state: 'TX', country: 'USA', lat: 29.7604, lng: -95.3698 },
  { city: 'Phoenix', state: 'AZ', country: 'USA', lat: 33.4484, lng: -112.0740 },
  { city: 'Philadelphia', state: 'PA', country: 'USA', lat: 39.9526, lng: -75.1652 },
  { city: 'San Antonio', state: 'TX', country: 'USA', lat: 29.4241, lng: -98.4936 },
  { city: 'San Diego', state: 'CA', country: 'USA', lat: 32.7157, lng: -117.1611 },
  { city: 'Dallas', state: 'TX', country: 'USA', lat: 32.7767, lng: -96.7970 },
  { city: 'San Jose', state: 'CA', country: 'USA', lat: 37.3382, lng: -121.8863 },
];

// Helper functions
const getRandomElement = (array) => array[Math.floor(Math.random() * array.length)];

const getRandomElements = (array, count) => {
  const shuffled = [...array].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
};

const getRandomLocation = () => {
  const city = getRandomElement(CITIES);
  // Add some randomness to coordinates (within ~10km)
  const latOffset = (Math.random() - 0.5) * 0.1;
  const lngOffset = (Math.random() - 0.5) * 0.1;
  
  return {
    type: 'Point',
    coordinates: [city.lng + lngOffset, city.lat + latOffset],
    address: {
      city: city.city,
      state: city.state,
      country: city.country,
    },
  };
};

const getRandomDateOfBirth = () => {
  const minAge = 18;
  const maxAge = 50;
  const age = Math.floor(Math.random() * (maxAge - minAge + 1)) + minAge;
  const date = new Date();
  date.setFullYear(date.getFullYear() - age);
  date.setMonth(Math.floor(Math.random() * 12));
  date.setDate(Math.floor(Math.random() * 28) + 1);
  return date;
};

const generatePhotos = (gender) => {
  const photos = [];
  const photoCount = Math.floor(Math.random() * 4) + 2; // 2-5 photos
  
  for (let i = 0; i < photoCount; i++) {
    photos.push({
      url: faker.image.avatar(),
      thumbnailUrl: faker.image.avatar(),
      order: i,
      isMain: i === 0,
      isVerified: Math.random() > 0.7,
      uploadedAt: faker.date.past(),
    });
  }
  
  return photos;
};

// Seed functions
async function seedUsers() {
  console.log('🌱 Seeding users...');
  const users = [];
  const hashedPassword = await bcrypt.hash('password123', 10);

  for (let i = 0; i < SEED_CONFIG.users; i++) {
    const gender = faker.helpers.arrayElement(['male', 'female', 'non-binary']);
    const firstName = faker.person.firstName(gender === 'male' ? 'male' : 'female');
    const lastName = faker.person.lastName();
    const location = getRandomLocation();

    const user = {
      email: faker.internet.email({ firstName, lastName }).toLowerCase(),
      phoneNumber: faker.phone.number('+1##########'),
      password: hashedPassword,
      profile: {
        firstName,
        lastName,
        displayName: firstName,
        dateOfBirth: getRandomDateOfBirth(),
        bio: getRandomElement(BIOS),
        gender,
        sexualOrientation: faker.helpers.arrayElements(['straight', 'gay', 'lesbian', 'bisexual'], { min: 1, max: 2 }),
        location,
        photos: generatePhotos(gender),
        height: faker.number.int({ min: 150, max: 200 }),
        interests: getRandomElements(INTERESTS, faker.number.int({ min: 3, max: 8 })),
        lifestyle: {
          drinking: faker.helpers.arrayElement(['never', 'socially', 'frequently']),
          smoking: faker.helpers.arrayElement(['never', 'occasionally', 'regularly']),
          workout: faker.helpers.arrayElement(['never', 'sometimes', 'often']),
          pets: faker.helpers.arrayElements(['dog', 'cat', 'none'], { min: 0, max: 2 }),
          children: faker.helpers.arrayElement(['none', 'have', 'want', 'dont_want']),
        },
        education: {
          level: faker.helpers.arrayElement(['high_school', 'bachelors', 'masters', 'phd']),
          school: faker.company.name() + ' University',
          major: faker.person.jobArea(),
        },
        career: {
          jobTitle: faker.person.jobTitle(),
          company: faker.company.name(),
        },
      },
      preferences: {
        ageRange: {
          min: 18,
          max: 50,
        },
        maxDistance: faker.number.int({ min: 10, max: 100 }),
        genderPreference: gender === 'male' ? ['female'] : gender === 'female' ? ['male'] : ['male', 'female', 'non-binary'],
        showMe: true,
      },
      subscription: {
        type: faker.helpers.weightedArrayElement([
          { value: 'free', weight: 70 },
          { value: 'plus', weight: 15 },
          { value: 'gold', weight: 10 },
          { value: 'platinum', weight: 5 },
        ]),
        validUntil: faker.date.future(),
      },
      verification: {
        email: {
          verified: Math.random() > 0.2,
          verifiedAt: faker.date.past(),
        },
        phone: {
          verified: Math.random() > 0.5,
          verifiedAt: faker.date.past(),
        },
      },
      scoring: {
        eloScore: faker.number.int({ min: 1000, max: 2000 }),
        activityScore: Math.random(),
        profileCompleteness: Math.random(),
      },
      status: {
        isActive: true,
        isOnline: Math.random() > 0.7,
        lastActive: faker.date.recent(),
      },
      createdAt: faker.date.past({ years: 2 }),
      updatedAt: faker.date.recent(),
    };

    users.push(user);
  }

  const insertedUsers = await User.insertMany(users);
  console.log(`✅ Created ${insertedUsers.length} users`);
  return insertedUsers;
}

async function seedSwipes(users) {
  console.log('🌱 Seeding swipes...');
  const swipes = [];

  for (const user of users) {
    const otherUsers = users.filter(u => u._id.toString() !== user._id.toString());
    const targetUsers = getRandomElements(otherUsers, Math.min(SEED_CONFIG.swipesPerUser, otherUsers.length));

    for (const targetUser of targetUsers) {
      const action = faker.helpers.weightedArrayElement([
        { value: 'like', weight: 40 },
        { value: 'nope', weight: 55 },
        { value: 'superlike', weight: 5 },
      ]);

      swipes.push({
        from: user._id,
        to: targetUser._id,
        action,
        swipedAt: faker.date.recent({ days: 30 }),
        isActive: true,
      });
    }
  }

  const insertedSwipes = await Swipe.insertMany(swipes);
  console.log(`✅ Created ${insertedSwipes.length} swipes`);
  return insertedSwipes;
}

async function seedMatches(users, swipes) {
  console.log('🌱 Seeding matches...');
  const matches = [];
  const matchedPairs = new Set();

  // Find mutual likes
  for (const swipe of swipes) {
    if (swipe.action === 'like' || swipe.action === 'superlike') {
      // Check if there's a reciprocal like
      const reciprocal = swipes.find(s => 
        s.from.toString() === swipe.to.toString() &&
        s.to.toString() === swipe.from.toString() &&
        (s.action === 'like' || s.action === 'superlike')
      );

      if (reciprocal) {
        const pairKey = [swipe.from, swipe.to].sort().join('-');
        
        if (!matchedPairs.has(pairKey)) {
          matchedPairs.add(pairKey);
          
          matches.push({
            users: [swipe.from, swipe.to],
            matchedAt: faker.date.recent({ days: 20 }),
            status: {
              isActive: Math.random() > 0.1, // 90% active matches
            },
            interaction: {
              lastMessageAt: faker.date.recent({ days: 5 }),
              messageCount: 0,
            },
          });
        }
      }
    }
  }

  const insertedMatches = await Match.insertMany(matches);
  console.log(`✅ Created ${insertedMatches.length} matches`);
  return insertedMatches;
}

async function seedMessages(matches) {
  console.log('🌱 Seeding messages...');
  const messages = [];
  
  const messageTemplates = [
    'Hey! How are you?',
    'Hi there! 😊',
    'Love your profile!',
    'We matched! How\'s your day going?',
    'Hey! What are you up to?',
    'Your photos are amazing!',
    'Hi! Where was that photo taken?',
    'Hello! How\'s your week been?',
    'Hey! Any fun plans for the weekend?',
    'Hi! I see you like {interest} too!',
  ];

  for (const match of matches) {
    if (!match.status.isActive) continue;
    
    const messageCount = faker.number.int({ min: 1, max: SEED_CONFIG.messagesPerMatch });
    const [user1, user2] = match.users;
    
    for (let i = 0; i < messageCount; i++) {
      const sender = Math.random() > 0.5 ? user1 : user2;
      const receiver = sender === user1 ? user2 : user1;
      
      messages.push({
        matchId: match._id,
        sender,
        receiver,
        content: {
          type: 'text',
          text: faker.helpers.arrayElement(messageTemplates),
        },
        status: {
          delivered: true,
          read: Math.random() > 0.3,
        },
        sentAt: faker.date.recent({ days: 5 }),
      });
    }
    
    // Update match message count
    match.interaction.messageCount = messageCount;
    await match.save();
  }

  const insertedMessages = await Message.insertMany(messages);
  console.log(`✅ Created ${insertedMessages.length} messages`);
  return insertedMessages;
}

async function clearDatabase() {
  console.log('🗑️  Clearing existing data...');
  await User.deleteMany({});
  await Swipe.deleteMany({});
  await Match.deleteMany({});
  await Message.deleteMany({});
  console.log('✅ Database cleared');
}

async function main() {
  try {
    // Connect to MongoDB
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/tinder', {
      maxPoolSize: 10,
    });
    console.log('✅ Connected to MongoDB');

    // Ask for confirmation
    if (process.env.NODE_ENV === 'production') {
      console.log('⚠️  WARNING: You are about to seed the PRODUCTION database!');
      console.log('Press Ctrl+C to cancel, or wait 5 seconds to continue...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    // Clear existing data
    const shouldClear = process.argv.includes('--clear') || process.argv.includes('-c');
    if (shouldClear) {
      await clearDatabase();
    }

    // Seed data
    console.log('🚀 Starting seed process...');
    console.log(`Configuration: ${JSON.stringify(SEED_CONFIG, null, 2)}`);
    
    const users = await seedUsers();
    const swipes = await seedSwipes(users);
    const matches = await seedMatches(users, swipes);
    await seedMessages(matches);

    // Create indexes
    console.log('📇 Creating indexes...');
    await User.collection.createIndex({ 'profile.location': '2dsphere' });
    await User.collection.createIndex({ email: 1 });
    await User.collection.createIndex({ 'scoring.eloScore': -1 });
    await Swipe.collection.createIndex({ from: 1, to: 1 }, { unique: true });
    await Match.collection.createIndex({ users: 1 });
    await Message.collection.createIndex({ matchId: 1, sentAt: -1 });
    console.log('✅ Indexes created');

    // Summary
    console.log('\n📊 Seed Summary:');
    console.log(`- Users: ${users.length}`);
    console.log(`- Swipes: ${swipes.length}`);
    console.log(`- Matches: ${matches.length}`);
    console.log(`- Messages: ${await Message.countDocuments()}`);
    
    console.log('\n🎉 Seeding completed successfully!');
    
    // Print sample user credentials
    console.log('\n📧 Sample User Credentials:');
    const sampleUsers = users.slice(0, 3);
    sampleUsers.forEach(user => {
      console.log(`Email: ${user.email} | Password: password123`);
    });

  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('👋 Database connection closed');
    process.exit(0);
  }
}

// Run the seeder
main();