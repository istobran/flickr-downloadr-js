const http = require('http');
const fsPromises = require('fs').promises;
const download = require('download');
const Flickr = require('flickr-sdk');
const parse = require('url').parse;
const promiseRetry = require('promise-retry');
const concatLimit = require('async/concatLimit');
const eachOfLimit = require('async/eachOfLimit');
const log4js = require('log4js');
const logger = log4js.getLogger();
const config = require('./config');

logger.level = 'debug';
log4js.configure({
  appenders: {
    out: { type: 'stdout' },
    cheese: { type: 'file', filename: 'download.log' }
  },
  categories: {
    default: { appenders: ['cheese', 'out'], level: 'debug' }
  },
});

function listenToAnswer() {
  return new Promise((resolve) => {
    const server = http.createServer(function (req, res) {
      const url = parse(req.url, true);
      res.write("You can close that tab now.");
      res.end();
      server.close();
      return resolve(url.query.oauth_verifier);
    }).listen(3000);
  });
}

function generateFieldFlattener(field) {
  return function (entry) {
    entry[field] = entry[field]["_content"];
    return entry;
  }
}

async function oauthLogin(consumer_key, consumer_secret) {
  const oauth = new Flickr.OAuth(consumer_key, consumer_secret);
  const { body } = await oauth.request('http://localhost:3000');
  const { oauth_token, oauth_token_secret } = body;
  logger.info(`Go to this URL and authorize the application: ${oauth.authorizeUrl(oauth_token, 'delete')}`);
  const oauth_verifier = await listenToAnswer();
  const { body: userInfo } = await oauth.verify(oauth_token, oauth_verifier, oauth_token_secret);
  return Flickr.OAuth.createPlugin(
    consumer_key,
    consumer_secret,
    userInfo.oauth_token,
    userInfo.oauth_token_secret,
  );
}

async function getAlbumList(flickr) {
  try {
    const list = await promiseRetry(retry => {
      return flickr.photosets.getList().catch(retry)
    }, { retries: 5 })
    return list.body.photosets.photoset
      .map(generateFieldFlattener("title"))
      .map(generateFieldFlattener("description"));
  } catch (err) {
    logger.error(`failed to fetch all album list: ${err.message}`);
    throw err;
  }
}

async function getPhotos(flickr, photoset_id, user_id, album_size) {
  const result = [];
  const per_page = 500;
  for (let page = 1; (page - 1) * per_page < album_size; page++) {
    const res = await flickr.photosets.getPhotos({
      photoset_id,
      user_id,
      page,
      per_page,
    });
    result.push(...res.body.photoset.photo);
  }
  return result;
}

async function getOriginalSize(flickr, photo_id) {
  const res = await flickr.photos.getSizes({ photo_id });
  return res.body.sizes.size.find(size => size.label === 'Original');
}

async function downloadImage(url, dirname, filename, ext) {
  await promiseRetry(async retry => {
    try {
      await fsPromises.writeFile(
        `photos/${dirname}/${filename}.${ext}`,
        await download(url),
        { flag: 'w+' }
      );
    } catch (err) {
      if (err.code === 'ENOENT') {
        await fsPromises.mkdir(`photos/${dirname}`, { recursive: true });
      }
      retry(err);
    }
  }, { retries: 1 });
}

async function fetchAllAlbums(flickr, albumList) {
  let successCount = 0;
  const photos = await concatLimit(albumList, 5, (album, callback) => {
    return promiseRetry(retry => {
      return getPhotos(flickr, album.id, album.owner, album.photos)
        .then(newPhotos => {
          successCount++;
          logger.info(`(${successCount}/${albumList.length}) fetched album ${album.title}: size ${newPhotos.length}`);
          callback(null, newPhotos.map(newPhoto => ({
            id: newPhoto.id,
            title: newPhoto.title,
            album: album.title,
          })));
        })
        .catch(err => {
          logger.warn(`failed to fetch album info: ${album.title} retrying...`);
          retry(err);
        })
    }, { retries: 5 })
      .catch(err => {
        logger.error(`failed to fetch album info: ${album.id} ${album.owner} ${album.title} ${err.message}`);
        callback(err);
      });
  });
  logger.info(`successfully fetched ${albumList.length} album info, contains ${photos.length} photos`);
  return photos;
}

async function fetchAllPhotoUrl(flickr, photos) {
  let successCount = 0;
  const imgFiles = await concatLimit(photos, 5, (photo, callback) => {
    return promiseRetry(retry => {
      return getOriginalSize(flickr, photo.id)
        .then(orig => {
          successCount++;
          logger.info(`(${successCount}/${photos.length}) fetched original photo url for ${photo.title}`);
          callback(null, {
            url: orig.source,
            dirname: photo.album,
            filename: photo.title,
            ext: orig.source.split('.').pop(),
          });
        })
        .catch(err => {
          logger.warn(`failed to fetch photo info: ${photo.title} retrying...`);
          retry(err);
        })
    }, { retries: 5 })
      .catch(err => {
        logger.error(`failed to fetch photo info: ${photo.id} ${photo.title} ${err.message}`);
        callback(err);
      });
  });
  logger.info(`successfully fetched ${imgFiles.length} photo url`);
  return imgFiles;
}

async function downloadAllPhotos(imgFiles) {
  let successCount = 0;
  await eachOfLimit(imgFiles, 5, (img, index, callback) => {
    return promiseRetry(retry => {
      return downloadImage(img.url, img.dirname, img.filename, img.ext)
        .then(() => {
          successCount++;
          logger.info(`(${successCount}/${imgFiles.length}) downloaded image: ${img.dirname}/${img.filename}.${img.ext}`);
          callback();
        })
        .catch(err => {
          logger.warn(`failed to download image: ${img.url} retrying...`);
          retry(err);
        })
    }, { retries: 5 })
      .catch(err => {
        logger.error(`failed to download image: ${img.url} ${err.message}`);
        callback(err);
      });
  });
  logger.info(`successfully downloaded ${successCount} images of ${imgFiles.length}`);
}

async function main() {
  const { CONSUMER_KEY, CONSUMER_SECRET, OAUTH_TOKEN, OAUTH_TOKEN_SECRET } = config;
  let options;
  if (CONSUMER_KEY
    && CONSUMER_SECRET
    && OAUTH_TOKEN
    && OAUTH_TOKEN_SECRET) {
    options = Flickr.OAuth.createPlugin(
      CONSUMER_KEY,
      CONSUMER_SECRET,
      OAUTH_TOKEN,
      OAUTH_TOKEN_SECRET,
    );
  } else if (CONSUMER_KEY && CONSUMER_SECRET) {
    options = await oauthLogin(CONSUMER_KEY, CONSUMER_SECRET);
  } else {
    throw new Error('CONSUMER_KEY and CONSUMER_SECRET are necessary!')
  }
  const flickr = new Flickr(options);
  logger.info('fetching album list');
  const list = await getAlbumList(flickr);
  const photos = await fetchAllAlbums(flickr, list);
  const imgFiles = await fetchAllPhotoUrl(flickr, photos);
  await downloadAllPhotos(imgFiles);
}
main();
