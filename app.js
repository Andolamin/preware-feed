/*jslint node: true, plusplus: true, nomen: true, esnext: true*/
(function () {
	'use strict';
	var express = require('express'),
	    cluster = require('cluster'),
	    numCPUs = require('os').cpus().length,
	    Sequelize = require("sequelize"),
	    db = new Sequelize(process.env.DATABASE_URL),
	    bodyParser = require('body-parser'),
	    crypto = require('crypto'),
	    url = require('url'),
	    https = require('https'),
	    request = require('request'),
	    i, server;

	// Databases
	var Package = db.define('packages', {
	    Package: Sequelize.STRING,
	    Size: Sequelize.INTEGER,
	    Architecture: Sequelize.STRING,
	    Section: Sequelize.STRING,
	    Filename: Sequelize.STRING,
	    Depends: Sequelize.STRING,
	    Maintainer: Sequelize.STRING,
	    Version: Sequelize.STRING,
	    Description: Sequelize.STRING,
	    MD5Sum: Sequelize.STRING,
	    Source: Sequelize.JSON,
	    Feed: Sequelize.STRING
	});

	var Redirect = db.define('redirects', {
	    Filename: Sequelize.STRING,
	    Location: Sequelize.STRING,
	    Feed: Sequelize.STRING
	});

	function addOrUpdateRedirect(filename, feed, location) {
		Redirect
			.findOrCreate({
				where: {
					Filename: filename,
					Feed: feed
				},
				defaults: {
					Location: location
				}
			})
			.spread((redirect, created) => {
				if (!created) {
					redirect.Location = location;
					redirect.save();
				}
			});
	}

	db.sync().then(() => {

		if (cluster.isMaster) {
			// Fork workers.
			for (i = 0; i < numCPUs; i++) {
				cluster.fork();
			}

			cluster.on('exit', (worker) => {
				console.log('worker ' + worker.process.pid + ' died');
				console.log('spawing a new worker');
				cluster.fork();
			});
		} else {
			server = express();

			server.use(bodyParser.json());

			server.use((req, res, next) => {
				console.log('Incoming request (' +
							req.path +
							') handled by worker ' + cluster.worker.id);
				next();
			});

			// TODO: this code is fixed to testing/stable feeds. Try to make this more generic
			server.post('/releaseHook', (req, res) => {
				// Verify required fields
				if (!req.body || // Should be JSON
				    req.body.action !== "published" || // Should be correct hook
				    !req.body.release || // Should have a release
				    !req.body.repository || // Should have a repository
				    !req.body.repository.name || // Repository should have a name
				    !req.body.release.assets || // Should have assets
				    req.body.release.assets.length !== 1) { // Should have one asset
					res.status(400).end();
				} else {
					var feed = req.body.release.tag_name.indexOf("alpha") >= 0 ? "alpha" : req.body.release.tag_name.indexOf("beta") >= 0 ? "beta" : "stable";
					Package.findOne({
						where: {
							Package: req.body.repository.name,
							Feed: feed 
						}
					}).then((pkg) => {
						// Calculate the hash
						var hash = crypto.createHash('md5');

						var parsedURL = url.parse(req.body.release.assets[0].browser_download_url);

						var options = {method: 'HEAD', host: parsedURL.host, port: 443, path: parsedURL.path};

						https.request(options, (response) => {
							var newURL = url.parse(response.headers.location);
							var newOptions = {method: 'GET', host: newURL.host, port: 443, path: newURL.path};
							https.request(newOptions, (response) => {
								response.on('data', (data) => {
									hash.update(data);
								});

								response.on('end', () => {
									var MD5Sum = hash.digest('hex');
									pkg.MD5Sum = MD5Sum;
									pkg.Filename = req.body.release.assets[0].name;
									pkg.Size = req.body.release.assets[0].size;
									pkg.Version = req.body.release.tag_name;
									// pkg.Source.Location = req.body.release.assets[0].browser_download_url;

									addOrUpdateRedirect(req.body.release.assets[0].name, feed, req.body.release.assets[0].browser_download_url);

									pkg.Source.LastUpdated = "" + (Date.parse(req.body.release.published_at)/1000);
									pkg.Source.Changelog = req.body.release.html_url;
									pkg.save({
										fields: (pkg.changed() || []).concat(['Source'])
									}).then(() => {
										res.status(200).end();
									}).catch(() => {
										res.status(500).end();
									});
								})

								response.on('error', () => {
									res.status(500).end();
								});
							}).end();
						}).end();

					});
				}
			});

			server.post('/addPackage', (req, res) => {
				if (req.header('SECRET') !== process.env.SECRET) {
					req.status(401).end();
				} else {
					var body = req.body;
					// TODO: verify required parameters
					Package.create({
						Package: body.Package,
						Size: 0,
						Architecture: body.Architecture,
						Section: body.Section,
						Filename: "",
						Depends: body.Depends,
						Maintainer: body.Maintainer,
						Version: body.Version,
						Description: body.Description,
						MD5Sum: "",
						Source: body.Source,
						Feed: "alpha"
					});
					Package.create({
						Package: body.Package,
						Size: 0,
						Architecture: body.Architecture,
						Section: body.Section,
						Filename: "",
						Depends: body.Depends,
						Maintainer: body.Maintainer,
						Version: body.Version,
						Description: body.Description,
						MD5Sum: "",
						Source: body.Source,
						Feed: "beta"
					});
					Package.create({
						Package: body.Package,
						Size: 0,
						Architecture: body.Architecture,
						Section: body.Section,
						Filename: "",
						Depends: body.Depends,
						Maintainer: body.Maintainer,
						Version: body.Version,
						Description: body.Description,
						MD5Sum: "",
						Source: body.Source,
						Feed: "stable"
					});
					res.status(200).end();
				}
			});

			server.get('/:feed/Packages', (req, res) => {
				Package.findAll({
					where: {
						Feed: req.params.feed
					}
				}).then((pkgs) => {
					res.set('Content-Type', 'text/plain');
					var response = "";

					for (var pkg of pkgs) {
						response += "Package: " + pkg.Package + "\n";
						response += "Size: " + pkg.Size + "\n";
						response += "Architecture: " + pkg.Architecture + "\n";
						response += "Section: " + pkg.Section + "\n";
						response += "Filename: " + pkg.Filename + "\n";
						if (pkg.Depends !== "") {
							response += "Depends: " + pkg.Depends + "\n";
						}
						response += "Maintainer: " + pkg.Maintainer + "\n";
						response += "Version: " + pkg.Version + "\n";
						response += "Description: " + pkg.Description + "\n";
						response += "MD5Sum: " + pkg.MD5Sum + "\n";

						var source = pkg.Source;
						source.Feed = process.env.FEED_PREFIX + "-" + req.params.feed;

						response += "Source: " + JSON.stringify(source) + "\n";
						response += "\n";
					}

					res.status(200).send(response);
				});
			});

			server.get('/:feed/:file', (req, res) => {
				Redirect.findOne({
					where: {
						Filename: req.params.file,
						Feed: req.params.feed
					}
				}).then((redirect) => {
					if (redirect === null) {
						res.status(404).send("Cannot GET " + req.path);
					} else {
						request.get(redirect.Location).pipe(res);
					}
				});
			});

			// TODO: implement Packages.gz handler

			server.listen(process.env.PORT || 5000);
		}
	});
}());
