'use strict';

const _ = require('lodash');

/**
 * A set of functions called "actions" for `ContentManager`
 */

module.exports = {
  fetchAll: async (params, query) => {
    const { limit, skip = 0, sort, query : request, queryAttribute, source, page } = query;

    // Find entries using `queries` system
    return await strapi.query(params.model, source).find({
      limit,
      skip,
      sort,
      query: request,
      queryAttribute
    });
  },

  count: async (params, source) => {
    return await strapi.query(params.model, source).count();
  },

  fetch: async (params, source) => {
    return await strapi.query(params.model, source).findOne({
      id: params.id
    });
  },

  add: async (params, values, source) => {
    // Create an entry using `queries` system
    return await strapi.query(params.model, source).create({
      values
    });
  },

  edit: async (params, values, source) => {
    // Multipart/form-data.
    if (values.hasOwnProperty('fields') && values.hasOwnProperty('files')) {
      // Silent recursive parser.
      const parser = (value) => {
        try {
          value = JSON.parse(value);
        } catch (e) {
          // Silent.
        }

        if (_.isArray(value)) {
          value = value.map(obj => parser(obj));
        }

        return value;
      };

      // Parse stringify JSON data.
      const parsedFields = Object.keys(values.fields).reduce((acc, current) => {
        acc[current] = parser(values.fields[current]);

        return acc;
      }, {});

      // Update JSON fields (files are exlucded).
      const fields = await strapi.query(params.model, source).update({
        id: params.id,
        values: parsedFields
      });

      // Request plugin upload.
      if (strapi.plugins.upload) {
        const config = await strapi.store({
          environment: strapi.config.environment,
          type: 'plugin',
          name: 'upload'
        }).get({ key: 'provider' });

        // Retrieve primary key.
        const primaryKey = strapi.query(params.model, source).primaryKey;

        // Delete removed files.
        const entry =  await strapi.query(params.model, source).findOne({
          id: params.id
        });

        const model = source && source !== 'content-manager' ?
          strapi.plugins[source].models[params.model]:
          strapi.models[params.model];

        const arrayOfPromises = [];

        model.associations
          .filter(association => association.via === 'related')
          .forEach(association => {
            // Remove deleted files.
            if (parsedFields[association.alias]) {
              const transformToArrayID = (array) => {
                return _.isArray(array) ? array.map(value => {
                  if (_.isPlainObject(value)) {
                    return value[primaryKey];
                  }

                  return value;
                }) : array;
              };

              // Compare array of ID to find deleted files.
              const currentValue = transformToArrayID(parsedFields[association.alias]).map(id => id.toString());
              const storedValue = transformToArrayID(entry[association.alias]).map(id => id.toString());

              const removeRelations = _.difference(storedValue, currentValue);

              // console.log("Current", currentValue);
              // console.log("Stored", storedValue);
              // console.log("removeRelations", removeRelations);

              removeRelations.forEach(id => {
                arrayOfPromises.push(strapi.plugins.upload.services.upload.edit({
                  id
                }, {
                  related: []
                }))
              });

              // TODO:
              // - Remove relationships in files.
            }
          });


        Object.keys(values.files)
          .map(async attribute => {
            // Bufferize files per attribute.
            const buffers = await strapi.plugins.upload.services.upload.bufferize(values.files[attribute]);
            const files = buffers.map(file => {
              // Add related information to be able to make
              // the relationships later.
              file.related = [{
                refId: params.id,
                ref: params.model,
                source,
                field: attribute,
              }];

              return file;
            });

            // Make upload async.
            arrayOfPromises.push(strapi.plugins.upload.services.upload.upload(files, config))
          });

        await Promise.all(arrayOfPromises);
      }

      return fields;
    }

    // Raw JSON.
    return strapi.query(params.model, source).update({
      id: params.id,
      values
    });
  },

  delete: async (params, { source }) => {
    const response = await strapi.query(params.model, source).findOne({
      id: params.id
    });

    params.values = Object.keys(JSON.parse(JSON.stringify(response))).reduce((acc, current) => {
      const association = (strapi.models[params.model] || strapi.plugins[source].models[params.model]).associations.filter(x => x.alias === current)[0];

      // Remove relationships.
      if (association) {
        acc[current] = _.isArray(response[current]) ? [] : null;
      }

      return acc;
    }, {});

    if (!_.isEmpty(params.values)) {
      // Run update to remove all relationships.
      await strapi.query(params.model, source).update(params);
    }

    // Delete an entry using `queries` system
    return await strapi.query(params.model, source).delete({
      id: params.id
    });
  },
};
