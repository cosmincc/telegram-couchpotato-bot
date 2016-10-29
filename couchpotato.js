'use strict';

var fs             = require('fs');                        // https://nodejs.org/api/fs.html
var _              = require('lodash');                    // https://www.npmjs.com/package/lodash
var NodeCache      = require('node-cache');                // https://www.npmjs.com/package/node-cache
var CouchPotatoAPI = require('couchpotato-api');           // https://www.npmjs.com/package/couchpotato-api
var TelegramBot    = require('node-telegram-bot-api');     // https://www.npmjs.com/package/node-telegram-bot-api

var state  = require(__dirname + '/lib/state');         // handles command structure
var logger = require(__dirname + '/lib/logger');        // logs to file and console
var i18n   = require(__dirname + '/lib/lang');          // set up multilingual support
var config = require(__dirname + '/lib/config');        // the concised configuration
var acl    = require(__dirname + '/lib/acl');           // set up the acl file

/*
 * set up the telegram bot
 */
var bot = new TelegramBot(config.telegram.botToken, { polling: true });

/*
 * set up the couchpotato api
 */
var couchpotato = new CouchPotatoAPI({
  hostname: config.couchpotato.hostname, apiKey: config.couchpotato.apiKey,
  port: config.couchpotato.port, urlBase: config.couchpotato.urlBase,
  ssl: config.couchpotato.ssl, username: config.couchpotato.username,
  password: config.couchpotato.password
});

/*
 * set up a simple caching tool
 */
var cache = new NodeCache({ stdTTL: 120, checkperiod: 150 });

/*
get the bot name
 */
bot.getMe()
  .then(function(msg) {
    logger.info('couchpotato bot %s initialized', msg.username);
  })
  .catch(function(err) {
    throw new Error(err);
  });

/*
handle start command
 */
bot.onText(/\/start/, function(msg) {
  var chatId = msg.chat.id;
  verifyUser(msg.from.id, chatId);

  var response = ['Hello @' + getTelegramName(msg.from) + '!'];
  response.push('\n`/help` to continue...');

  sendMessage(chatId, response.join('\n'));
});

/*
 * handle help command
 */
bot.onText(/\/help/, function(msg) {
  var chatId = msg.chat.id;
  var userId = msg.from.id;

  verifyUser(userId, chatId);

  logger.info('user: %s, message: sent `/help` command', userId);
  var response = ['Below is a list of commands you(@' + getTelegramName(msg.from) + ') have access to:'];
  response.push('\n*General commands:*');
  response.push('`/start` to start this bot');
  response.push('`/help` to for this list of commands');
  response.push('`/q [movie name]` search for a movie');
  response.push('`/library [movie name]` search library');
  response.push('`/clear` clear all previous commands');

  if (isAdmin(userId)) {
    response.push('\n*Admin commands:*');
    response.push('`/wanted` search all missing/wanted movies');
    response.push('`/users` list users');
    response.push('`/revoke` revoke user from bot');
    response.push('`/unrevoke` un-revoke user from bot');
  }

  sendMessage(chatId, response.join('\n'));
});

/*
handle query command
 */
bot.onText(/\/[Qq](uery)?\s?(.+)?/, function(msg, match) {
  var chatId = msg.chat.id;
  var userId = msg.from.id;
  var movieName = match[2];

  verifyUser(userId, chatId);

  if (movieName) {
    handleMovieSearch(msg, movieName);
  } else {
    logger.info('user: %s message: entered movie query mode (state: %s)', userId, state.couchpotato.MOVIE_SEARCH);
    cache.set('state' + userId, state.couchpotato.MOVIE_SEARCH);
    sendMessage(chatId, i18n.__('moviesLookup'), {
      reply_to_message_id: msg.message_id,
      reply_markup: {
        force_reply: true,
        selective: true
      }
    });
  }
 });

function handleMovieSearch(msg, movieName) {
  var chatId = msg.chat.id;
  var userId = msg.from.id;

  couchpotato.get('movie.search', { 'q': movieName })
    .then(function(result) {
      if (!result.movies) {
        cache.set('state' + userId, state.couchpotato.MOVIE_SEARCH);
        throw new Error('Could not find ' + movieName + ', try searching again');
      }
      return result.movies;
    })
    .then(function(movies) {
      logger.info('user: %s, message: requested to search for movie "%s"', userId, movieName);

      var movieList = [];
      var message = ['*Found ' + movies.length + ' movies:*'];
      var keyboardList = [];

      _.forEach(movies, function(n, key) {

        var id = key + 1;
        var title = n.original_title;
        var year = ('year' in n ? n.year : '');
        var rating = ('rating' in n ? ('imdb' in n.rating ? n.rating.imdb[0] + '/10' : '') : '');
        var movieId = ('imdb' in n ? n.imdb : n.tmdb_id);
        var thumb = ('images' in n ? ('poster' in n.images ? n.images.poster[0] : '') : '');
        var runtime = ('runtime' in n ? n.runtime : '');
        var onIMDb = ('via_imdb' in n ? true : false);
        var keyboardValue = title + (year ? ' - ' + year : '');

        movieList.push({
          id: id,
          title: title,
          year: year,
          rating: rating,
          movie_id: movieId,
          thumb: thumb,
          via_imdb: onIMDb,
          keyboard_value: keyboardValue
        });

        message.push(
          '*' + id + '*) ' +
          (onIMDb ? '[' + title + '](http://imdb.com/title/' + movieId + ')' : '[' + title + '](https://www.themoviedb.org/movie/' + movieId + ')') +
          (year ? ' - _' + year + '_' : '') +
          (rating ? ' - _' + rating + '_' : '') +
          (runtime ? ' - _' + runtime + 'm_' : '')
        );

        // One movie per row of custom keyboard
        keyboardList.push([keyboardValue]);
      });
      message.push('\nPlease select from the menu below.');

      // set cache
      cache.set('movieList' + userId, movieList);
      cache.set('state' + userId, state.couchpotato.MOVIE);

      return {
        message: message.join('\n'),
        keyboard: keyboardList
      };
    })
    .then(function(response) {
      sendMessage(chatId, response.message, {
        reply_to_message_id: msg.message_id,
        reply_markup: {
          keyboard: response.keyboard,
          one_time_keyboard: true,
          force_reply: true,
          selective: true
        }
      });
    })
    .catch(function(err) {
      replyWithError(userId, err, chatId);
    });

};

/*
 Captures any and all messages, filters out commands, handles profiles and movies
 sent via the custom keyboard.
 */
bot.on('message', function(msg) {
  var chatId = msg.chat.id;
  var userId = msg.from.id;
  var message = msg.text;

  verifyUser(userId, chatId);

  // If the message is a command, ignore it.
  if(msg.text[0] != '/') {
    // Check cache to determine state, if cache empty prompt user to start a movie search
    var currentState = cache.get('state' + userId);
    if (!currentState) {
      return replyWithError(userId, new Error(i18n.__('noState')), chatId);
    } else {
      switch(currentState) {
        case state.couchpotato.MOVIE_SEARCH:
          verifyUser(userId, chatId);
          logger.info('user: %s, message: entered the movie name: %s', userId, message);
          handleMovieSearch(msg, message);
          break;
        case state.couchpotato.MOVIE:
          logger.info('user: %s, message: choose the movie %s', userId, message);
          handleMovie(msg);
          break;
        case state.couchpotato.PROFILE:
          logger.info('user: %s, message: choose the profile "%s"', userId, message);
          handleProfile(chatId, userId, message);
          break;
        case state.admin.REVOKE_CONFIRM:
          verifyAdmin(userId, chatId);
          logger.info('user: %s, message: choose the revoke confirmation "%s"', userId, message);
          handleRevokeUserConfirm(msg);
          break;
        case state.admin.UNREVOKE:
          verifyAdmin(userId, chatId);
          logger.info('user: %s, message: choose to unrevoke user "%s"', userId, message);
          handleUnRevokeUser(msg);
          break;
        case state.admin.UNREVOKE_CONFIRM:
          verifyAdmin(userId, chatId);
          logger.info('user: %s, message: choose the unrevoke confirmation "%s"', userId, message);
          handleUnRevokeUserConfirm(msg);
          break;
        default:
          return replyWithError(userId, new Error(i18n.__('unknownState')), chatId);
      }
    }
  }
});

/*
 * handle full search of movies
 */
bot.onText(/\/wanted/, function(msg) {
  var chatId = msg.chat.id;
  var userId = msg.from.id;

  verifyAdmin(userId, chatId);

  couchpotato.get('movie.searcher.full_search')
    .then(function(result) {
      sendMessage(chatId, i18n.__('moviesWanted'));
    }).catch(function(err) {
      replyWithError(userId, err, chatId);
    });
});

/*
 * handle clear command
 */
bot.onText(/\/clear/, function(msg) {
  var chatId = msg.chat.id;
  var userId = msg.from.id;

  verifyUser(userId, chatId);

  logger.info('user: %s, message: sent \'/clear\' command', userId);
  clearCache(userId);
  logger.info('user: %s, message: \'/clear\' command successfully executed', userId);

  sendMessage(chatId, i18n.__('clear'));
});

/*
 * handle authorization
 */
bot.onText(/\/auth\s(.+)/, function(msg, match) {
  var chatId = msg.chat.id;
  var userId = msg.from.id;
  var password = match[1];

  if (isAuthorized(userId)) {
    return sendMessage(chatId, i18n.__('alreadyAuthorized'));
  }

  // make sure the user is not banned
  if (isRevoked(userId)) {
    return sendMessage(chatId, i18n.__('isRevoked'));
  }

  if (password !== config.bot.password) {
    return replyWithError(userId, new Error(i18n.__('invalidPassword')), chatId);
  }

  acl.allowedUsers.push(msg.from);
  updateACL();

  if (acl.allowedUsers.length === 1) {
    promptOwnerConfig(userId);
  }

  sendMessage(chatId, i18n.__('isAuthorized'));

  if (config.bot.owner) {
    sendMessage(config.bot.owner, getTelegramName(msg.from) + i18n.__('userAuthorized'));
  }
});

/*
 * handle users
 */
bot.onText(/\/users/, function(msg) {
  var chatId = msg.chat.id;
  var userId = msg.from.id;

  verifyAdmin(userId, chatId);

  var response = ['*' + i18n.__('allowedUsers') + ':*'];
  _.forEach(acl.allowedUsers, function(user, key) {
    response.push('*' + (key + 1) + '*) ' + getTelegramName(user));
  });

  sendMessage(chatId, response.join('\n'));
});

/*
 * handle user access revocation
 */
bot.onText(/\/revoke/, function(msg) {
  var chatId = msg.chat.id;
  var userId = msg.from.id;

  verifyAdmin(userId, chatId);

  if (!acl.allowedUsers.length) {
    return sendMessage(chatId, i18n.__('noAllowedUsers'));
  }

  var keyboardList = [], keyboardRow = [], revokeList = [];
  var response = ['*' + i18n.__('allowedUsers') + ':*'];
  _.forEach(acl.allowedUsers, function(user, key) {
    revokeList.push({
      'id': key + 1,
      'userId': n.id,
      'keyboardValue': getTelegramName(user)
    });
    response.push('*' + (key + 1) + '*) ' + getTelegramName(user));

    keyboardRow.push(getTelegramName(user));
    if (keyboardRow.length === 2) {
      keyboardList.push(keyboardRow);
      keyboardRow = [];
    }
  });

  response.push(i18n.__('selectFromMenu'));

  if (keyboardRow.length === 1) {
    keyboardList.push([keyboardRow[0]]);
  }

  // set cache
  cache.set('state' + userId, state.admin.REVOKE);
  cache.set('revokeUserList' + userId, revokeList);

  sendMessage(chatId, response.join('\n'), {
    reply_markup: { keyboard: keyboardList, one_time_keyboard: true },
  });
});

/*
 * handle user access unrevocation
 */
bot.onText(/\/unrevoke/, function(msg) {
  var chatId = msg.chat.id;
  var userId = msg.from.id;

  verifyAdmin(userId, chatId);

  if (!acl.revokedUsers.length) {
    return sendMessage(chatId, i18n.__('noRevokedUsers'));
  }

  var keyboardList = [], keyboardRow = [], revokeList = [];
  var response = ['*' + i18n.__('revokedUsers') + ':*'];
  _.forEach(acl.revokedUsers, function(user, key) {
    revokeList.push({
      'id': key + 1,
      'userId': user.id,
      'keyboardValue': getTelegramName(user)
    });

    response.push('*' + (key + 1) + '*) ' + getTelegramName(user));

    keyboardRow.push(getTelegramName(n));
    if (keyboardRow.length == 2) {
      keyboardList.push(keyboardRow);
      keyboardRow = [];
    }
  });

  response.push(i18n.__('selectFromMenu'));

  if (keyboardRow.length === 1) {
    keyboardList.push([keyboardRow[0]]);
  }

  // set cache
  cache.set('state' + userId, state.admin.UNREVOKE);
  cache.set('unrevokeUserList' + userId, revokeList);

  sendMessage(chatId, response.join('\n'), {
    reply_markup: { keyboard: keyboardList, one_time_keyboard: true }
  });
});

bot.onText(/\/library\s?(.+)?/, function(msg, match) {
  var chatId = msg.chat.id;
  var userId = msg.from.id;
  var query = match[1] || 0;
  /*
  status	array or csv	Filter media by status. Example:"active,done"
  search	string	Search media title
  release_status	array or csv	Filter media by status of its releases. Example:"snatched,available"
  limit_offset	string	Limit and offset the media list. Examples: "50" or "50,30"
  type	string	Media type to filter on.
  starts_with	string	Starts with these characters. Example: "a" returns all media starting with the letter "a"
  */

  couchpotato.get('media.list')
    .then(function(result) {
      logger.info('user: %s, message: all movies', userId);

      var response = [];
      _.forEach(result.movies, function(n, key) {
        var movieId = (n.imdb ? n.imdb : n.tmdb_id);
        var onIMDb = (n.via_imdb ? true : false);
        var movie = (onIMDb ? '[' + n.title + '](http://imdb.com/title/' + movieId + ')' : '[' + n.title + '](https://www.themoviedb.org/movie/' + movieId + ')');

        if (query) {
          if (n.title.search( new RegExp(query, 'i') ) !== -1) {
            response.push(movie);
          }
        } else {
          response.push(movie);
        }
      });

      if (!response.length) {
        return replyWithError(userId, new Error(i18n.__('queryNoResults') + ': ' + query), chatId);
      }

      response.sort();

      if (query) {
        // add title to beginning of the array
        response.unshift('*' + i18n.__('libraryFound') + ':*');
      }

      if (response.length > 50) {
        var splitReponse = _.chunk(response, 50);
        splitReponse.sort();
        _.forEach(splitReponse, function(n) {
          n.sort();
          sendMessage(chatId, n.join('\n'));
        });
      } else {
        sendMessage(chatId, response.join('\n'));
      }
    })
    .catch(function(err) {
      replyWithError(userId, err, chatId);
    })
    .finally(function() {
      clearCache(userId);
    });

});

function handleMovie(msg) {
  var chatId = msg.chat.id;
  var userId = msg.from.id;
  var movieDisplayName = msg.text;
  var movieList = cache.get('movieList' + userId);
  if (!movieList) {
    return replyWithError(userId, new Error(i18n.__('searchAgain')), chatId);
  }

  var movie = _.filter(movieList, function(item) { return item.keyboard_value === movieDisplayName; })[0];
  if(!movie){
    return replyWithError(userId, new Error(i18n.__('movieNotFound') + ' "' + movieDisplayName + '".'), chatId);
  }

  // create a workflow
  var workflow = new (require('events').EventEmitter)();

  // check for existing movie
  workflow.on('checkCouchPotatoMovie', function () {
    couchpotato.get('media.list')
      .then(function(result) {
        logger.info('user: %s, message: looking for existing movie', userId);

        var existingMovie = _.filter(result.movies, function(item) {
          return item.info.imdb == movie.movie_id || item.info.tmdb_id == movie.movie_id;
        })[0];

        if (existingMovie) {
          cache.set('state' + userId, state.couchpotato.MOVIE_SEARCH);
          throw new Error(i18n.__('movieExists'));
        }
        workflow.emit('getCouchPotatoProfile');
      }).catch(function(err) {
        replyWithError(userId, err, chatId);
      });
  });

  workflow.on('getCouchPotatoProfile', function () {

    // set movie option to cache
    cache.set('movieId' + userId, movie.id);

    couchpotato.get('profile.list')
      .then(function(result) {
        if (!result.list) {
          throw new Error(i18n.__('noProfiles'));
        }

        if (!cache.get('movieList' + userId)) {
          throw new Error(i18n.__('searchAgain'));
        }

        return result.list;
      })
      .then(function(profiles) {
        logger.info('user: %s, message: requested to get profile list with ' + profiles.length + ' entries', userId);

        // only select profiles that are enabled in CP
        var enabledProfiles = _.filter(profiles, function(item) { return (typeof item.hide == 'undefined' || item.hide == false); });

        var response = ['*' + i18n.__('foundProfiles') + ': ' + enabledProfiles.length + '*\n'];
        var profileList = [], keyboardList = [], keyboardRow = [];
        _.forEach(enabledProfiles, function(n, key) {
          profileList.push({
            'id': key,
            'label': n.label,
            'hash': n._id
          });

          response.push('*' + (key + 1) + '*) ' + n.label);

          // Profile names are short, put two on each custom
          // keyboard row to reduce scrolling
          keyboardRow.push(n.label);
          if (keyboardRow.length === 2) {
            keyboardList.push(keyboardRow);
            keyboardRow = [];
          }
        });

        if (keyboardRow.length === 1 && keyboardList.length === 0) {
          keyboardList.push([keyboardRow[0]]);
        }
        response.push(i18n.__('selectFromMenu'));


        // set cache
        cache.set('movieProfileList' + userId, profileList);
        cache.set('state' + userId, state.couchpotato.PROFILE);

        return {
          message: response.join('\n'),
          keyboard: keyboardList
        };
      })
      .then(function(response) {
        sendMessage(chatId, response.message, {
          reply_to_message_id: msg.message_id,
          reply_markup: {
            keyboard: response.keyboard,
            one_time_keyboard: true,
            force_reply: true,
            selective: true
          }
        });
      })
      .catch(function(err) {
        replyWithError(userId, err, chatId);
      });

    });

    /**
     * Initiate the workflow
     */
    workflow.emit('checkCouchPotatoMovie');

}

function handleProfile(msg) {
  var chatId = msg.chat.id;
  var userId = msg.from.id;
  var profileName = msg.text;
  var profileList = cache.get('movieProfileList' + userId);
  var movieId = cache.get('movieId' + userId);
  var movieList = cache.get('movieList' + userId);
  if (!profileList || !movieList || !movieId) {
    return replyWithError(userId, new Error(i18n.__('tryAgain')), chatId);
  }

  var profile = _.filter(profileList, function(item) { return item.label === profileName; })[0];
  if(!profile) {
    return replyWithError(userId, new Error(i18n.__('profileNotFound') + ' "' + profileName + '".'), chatId);
  }

  var movie = _.filter(movieList, function(item) { return item.id === movieId; })[0];

  couchpotato.get('movie.add', {
      'identifier': movie.movie_id,
      'title': movie.title,
      'profile_id': profile.hash
    })
    .then(function(result) {
      logger.info('user: %s, message: added movie "%s"', userId, movie.title);

      if (!result.success) {
        throw new Error(i18n.__('movieAddFail'));
      }

      sendMessage(chatId, '[' + i18n.__('movieAdded') + '!](' + movie.thumb + ')');
    })
    .catch(function(err) {
      replyWithError(userId, err, chatId);
    })
    .finally(function() {
      clearCache(userId);
    });
}

function handleRevokeUser(userId, revokedUser) {

  logger.info('user: %s, message: selected revoke user %s', userId, revokedUser);

  var keyboardList = [];
  var response = [i18n.__('revokeConfirm') + ' @' + revokedUser + '?'];
  keyboardList.push(['NO']);
  keyboardList.push(['yes']);

  // set cache
  cache.set('state' + userId, state.admin.REVOKE_CONFIRM);
  cache.set('revokedUserName' + userId, revokedUser);

  sendMessage(userId, response.join('\n'), {
    reply_markup: { keyboard: keyboardList, one_time_keyboard: true },
  });
}

function handleRevokeUserConfirm(msg) {
  var chatId = msg.chat.id;
  var userId = msg.from.id;
  var revokedConfirm = msg.text;
  logger.info('user: %s, message: selected revoke confirmation %s', userId, revokedConfirm);

  var revokedUser = cache.get('revokedUserName' + userId);
  var message = '';

  if (revokedConfirm === 'NO' || revokedConfirm === 'no') {
      clearCache(userId);
      message = i18n.__('accessNotRevoked') + ' @' + revokedUser + '.';
      return sendMessage(chatId, message);
  }

  var revokedUserList = cache.get('revokeUserList' + userId);
  var i = revokedUserList.map(function(e) { return e.keyboardValue; }).indexOf(revokedUser);
  var revokedUserObj = revokedUserList[i];
  var j = acl.allowedUsers.map(function(e) { return e.id; }).indexOf(revokedUserObj.userId);

  acl.revokedUsers.push(acl.allowedUsers[j]);
  acl.allowedUsers.splice(j, 1);
  updateACL();

  message = i18n.__('accessRevoked') + ' @' + revokedUser + '.';

  sendMessage(chatId, message);

  clearCache(userId);
}

function handleUnRevokeUser(msg) {
  var chatId = msg.chat.id;
  var userId = msg.from.id;
  var revokedUser = msg.text;

  // set cache
  cache.set('state' + userId, state.admin.UNREVOKE_CONFIRM);
  cache.set('revokedUserName' + userId, revokedUser);

  logger.info('user: %s, message: selected unrevoke user %s', userId, revokedUser);

  var response = i18n.__('unrevokeConfirm') + ' @' + revokedUser + '?';
  sendMessage(chatId, response, {
    reply_to_message_id: msg.message_id,
    reply_markup: {
      keyboard: [['NO'], ['yes']],
      one_time_keyboard: true,
      force_reply: true,
      selective: true
    }
  });
}

function handleUnRevokeUserConfirm(msg) {
  var chatId = msg.chat.id;
  var userId = msg.from.id;
  var revokedConfirm = msg.text;
  logger.info('user: %s, message: selected unrevoke confirmation %s', userId, revokedConfirm);

  var revokedUser = cache.get('revokedUserName' + userId);
  var message = '';
  if (revokedConfirm === 'NO' || revokedConfirm === 'no') {
      clearCache(userId);
      message = i18n.__('accessNotUnrevoked') + ' @' + revokedUser + '.';
      return sendMessage(chatId, message);
  }

  var unrevokedUserList = cache.get('unrevokeUserList' + userId);
  var i = unrevokedUserList.map(function(e) { return e.keyboardValue; }).indexOf(revokedUser);
  var unrevokedUserObj = unrevokedUserList[i];
  var j = acl.revokedUsers.map(function(e) { return e.id; }).indexOf(unrevokedUserObj.userId);
  acl.revokedUsers.splice(j, 1);
  updateACL();

  message = i18n.__('accessUnrevoked') + ' @' + revokedUser + '.';

  sendMessage(chatId, message);

  clearCache(userId);
}

/*
 * save access control list
 */
function updateACL() {
  fs.writeFile(__dirname + '/acl.json', JSON.stringify(acl), function(err) {
    if (err) {
      throw new Error(err);
    }

    logger.info('the access control list was updated');
  });
}

/*
 * verify user can use the bot
 */
function verifyUser(userId, chatId) {
  if (!isAuthorized(userId)) {
    return replyWithError(userId, new Error(i18n.__('notAuthorized')), chatId);
  }
}

/*
 * verify admin of the bot
 */
function verifyAdmin(userId, chatId) {
  if (isAuthorized(userId)) {
    promptOwnerConfig(userId);
  }

  if (config.bot.owner !== userId) {
    return replyWithError(userId, new Error(i18n.__('adminOnly')), chatId);
  }
}

function isAdmin(userId) {
  return config.bot.owner === userId;
}

/*
 * check to see is user is authenticated
 * returns true/false
 */
function isAuthorized(userId) {
  return _.some(acl.allowedUsers, { 'id': userId });
}

/*
 * check to see is user is banned
 * returns true/false
 */
function isRevoked(userId) {
  return _.some(acl.revokedUsers, { 'id': userId });
}

function promptOwnerConfig(userId) {
  if (!config.bot.owner) {
    var message = [i18n.__('yourUserId') + ': ' + userId, i18n.__('ownerConfig')];
    sendMessage(userId, message.join('\n'));
  }
}

/*
 * handle removing the custom keyboard
 */
function replyWithError(userId, err, chatId) {
  chatId = chatId || userId;
  if (typeof err === 'undefined') {
    err = new Error(i18n.__('unknownError'))
  }
  logger.warn('user: %s message: %s', userId, err.message);

  sendMessage(chatId, '*' + i18n.__('ohNo') + '* ' + err);
}

/*
 * clear caches
 */
function clearCache(userId) {
  var cacheItems = [
    'movieId', 'movieList', 'movieProfileList',
    'state', 'revokedUserName', 'revokeUserList'
  ];

  _(cacheItems).forEach(function(item) {
    cache.del(item + userId);
  });
}

/*
 * get telegram name
 */
function getTelegramName(user) {
  return user.username || (user.first_name + (' ' + user.last_name || '')) || user;
}

/*
 * reply with a message
 */
function sendMessage(chatId, message, opt_opts) {
  var opts = {
    disable_notification: true,
    disable_web_page_preview: true,
    parse_mode: 'Markdown',
    reply_markup: {
      hide_keyboard: true
    }
  };
  if (typeof opt_opts === 'object') { for (var attr in opt_opts) { opts[attr] = opt_opts[attr]; } }
  bot.sendMessage(chatId, message, opts);
}