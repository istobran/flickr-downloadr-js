# flickr-downloadr-js

> Download all flickr photos from your account by one-click

## Dependencies

* Node.js 12+

## Installation

1、Clone project into your local directory
```shell
git clone git@github.com:istobran/flickr-downloadr-js.git
```

2、Install packages
```shell
cd flickr-downloadr-js && npm i
```

## Configuration

1. See this [guide](https://www.flickr.com/services/api/misc.api_keys.html) to apply your application key  

2. Put your consumer key and secret into `config.js`
    ```shell script
    CONSUMER_KEY: '<put your consumer_key here>',
    CONSUMER_SECRET: '<put your consumer_secret here>',
    ```

3. (Optional) If you already have oauth token and secret, you can also append it to improve performance
    ```shell script
    OAUTH_TOKEN: '<put your oauth_token here>',
    OAUTH_TOKEN_SECRET: '<put your oauth_token_secret here>'
    ```

## Run

Just simply execute:
```shell
npm start
```
