export async function resetDailyLimits() {
  try {
    const now = new Date();
    
    // Reset free users' daily limits
    await User.updateMany(
      { 
        'subscription.type': 'free',
        'limits.lastReset': { 
          $lt: new Date(now - 24 * 60 * 60 * 1000) 
        }
      },
      {
        $set: {
          'limits.likesRemaining': 100,
          'limits.superLikesRemaining': 1,
          'limits.lastReset': now,
          'limits.messagesPerDay': 0,
          'limits.swipesPerDay': 0
        }
      }
    );

    // Reset premium users' daily limits
    await User.updateMany(
      { 
        'subscription.type': { $in: ['plus', 'gold', 'platinum'] },
        'limits.lastReset': { 
          $lt: new Date(now - 24 * 60 * 60 * 1000) 
        }
      },
      {
        $set: {
          'limits.superLikesRemaining': 5,
          'limits.lastReset': now,
          'limits.messagesPerDay': 0,
          'limits.swipesPerDay': 0
        }
      }
    );

    logger.info('Daily limits reset completed');
  } catch (error) {
    logger.error('Error resetting daily limits:', error);
  }
}