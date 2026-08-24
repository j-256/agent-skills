'use strict';

// B2C Commerce request-body persona -- the product-specific DATA the neutral
// leaf resolver (common/body-values.js) consumes. One coherent synthetic identity,
// keyed by NORMALIZED field name; covers exactly the free-form leaves the shipped
// registry entries name. maskedNumber matches the OCAPI OrderPaymentCardRequest
// regex and is obviously fake.

const PERSONA = {
  firstname: 'Jane',
  lastname: 'Doe',
  address1: '1 Market St',
  city: 'San Francisco',
  statecode: 'CA',
  postalcode: '94105',
  countrycode: 'US',
  quantity: 1,
  paymentmethodid: 'CREDIT_CARD',
  cardtype: 'Visa',
  maskednumber: '************4242',
};

// Instance-reference leaves: values that must name a REAL object on the target
// instance. Keyed by NORMALIZED final segment. Deliberately small + explicit.
const INSTANCE_REF_SEGMENTS = new Set([
  'productid',  // productId / product_id
  'id',         // shippingMethod.id / shipping_method.id
]);

module.exports = { PERSONA, INSTANCE_REF_SEGMENTS };
