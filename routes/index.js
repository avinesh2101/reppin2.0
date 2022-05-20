const express = require("express");
const csrf = require("csurf");
const stripe = require("stripe")(process.env.STRIPE_PRIVATE_KEY);
const Product = require("../models/product");
const Category = require("../models/category");
const Cart = require("../models/cart");
const Order = require("../models/order");
const middleware = require("../middleware");
const router = express.Router();
const { nanoid }  = require('nanoid');

const Razorpay = require('razorpay');
const PaymentDetail =  require('../models/payment-detail.js');

let razorPayInstance = new Razorpay({
	key_id: process.env.RAZORPAY_KEY_ID,
	key_secret: process.env.RAZORPAY_KEY_SECRET
})

const csrfProtection = csrf();
router.use(csrfProtection);

// GET: home page
router.get("/", async (req, res) => {
  try {
    const products = await Product.find({})
      .sort("-createdAt")
      .populate("category");
    res.render("shop/home", { pageName: "Home", products });
  } catch (error) {
    console.log(error);
    res.redirect("/");
  }
});

// GET: add a product to the shopping cart when "Add to cart" button is pressed
router.get("/add-to-cart/:id", async (req, res) => {
  const productId = req.params.id;
  try {
    // get the correct cart, either from the db, session, or an empty cart.
    let user_cart;
    if (req.user) {
      user_cart = await Cart.findOne({ user: req.user._id });
    }
    let cart;
    if (
      (req.user && !user_cart && req.session.cart) ||
      (!req.user && req.session.cart)
    ) {
      cart = await new Cart(req.session.cart);
    } else if (!req.user || !user_cart) {
      cart = new Cart({});
    } else {
      cart = user_cart;
    }

    // add the product to the cart
    const product = await Product.findById(productId);
    const itemIndex = cart.items.findIndex((p) => p.productId == productId);
    if (itemIndex > -1) {
      // if product exists in the cart, update the quantity
      cart.items[itemIndex].qty++;
      cart.items[itemIndex].price = cart.items[itemIndex].qty * product.price;
      cart.totalQty++;
      cart.totalCost += product.price;
    } else {
      // if product does not exists in cart, find it in the db to retrieve its price and add new item
      cart.items.push({
        productId: productId,
        qty: 1,
        price: product.price,
        title: product.title,
        productCode: product.productCode,
      });
      cart.totalQty++;
      cart.totalCost += product.price;
    }

    // if the user is logged in, store the user's id and save cart to the db
    if (req.user) {
      cart.user = req.user._id;
      await cart.save();
    }
    req.session.cart = cart;
    req.flash("success", "Item added to the shopping cart");
    res.redirect(req.headers.referer);
  } catch (err) {
    console.log(err.message);
    res.redirect("/");
  }
});

// GET: view shopping cart contents
router.get("/shopping-cart", async (req, res) => {
  try {
    // find the cart, whether in session or in db based on the user state
    let cart_user;
    if (req.user) {
      cart_user = await Cart.findOne({ user: req.user._id });
    }
    // if user is signed in and has cart, load user's cart from the db
    if (req.user && cart_user) {
      req.session.cart = cart_user;
      return res.render("shop/shopping-cart", {
        cart: cart_user,
        pageName: "Shopping Cart",
        products: await productsFromCart(cart_user),
      });
    }
    // if there is no cart in session and user is not logged in, cart is empty
    if (!req.session.cart) {
      return res.render("shop/shopping-cart", {
        cart: null,
        pageName: "Shopping Cart",
        products: null,
      });
    }
    // otherwise, load the session's cart
    return res.render("shop/shopping-cart", {
      cart: req.session.cart,
      pageName: "Shopping Cart",
      products: await productsFromCart(req.session.cart),
    });
  } catch (err) {
    console.log(err.message);
    res.redirect("/");
  }
});

// GET: reduce one from an item in the shopping cart
router.get("/reduce/:id", async function (req, res, next) {
  // if a user is logged in, reduce from the user's cart and save
  // else reduce from the session's cart
  const productId = req.params.id;
  let cart;
  try {
    if (req.user) {
      cart = await Cart.findOne({ user: req.user._id });
    } else if (req.session.cart) {
      cart = await new Cart(req.session.cart);
    }

    // find the item with productId
    let itemIndex = cart.items.findIndex((p) => p.productId == productId);
    if (itemIndex > -1) {
      // find the product to find its price
      const product = await Product.findById(productId);
      // if product is found, reduce its qty
      cart.items[itemIndex].qty--;
      cart.items[itemIndex].price -= product.price;
      cart.totalQty--;
      cart.totalCost -= product.price;
      // if the item's qty reaches 0, remove it from the cart
      if (cart.items[itemIndex].qty <= 0) {
        await cart.items.remove({ _id: cart.items[itemIndex]._id });
      }
      req.session.cart = cart;
      //save the cart it only if user is logged in
      if (req.user) {
        await cart.save();
      }
      //delete cart if qty is 0
      if (cart.totalQty <= 0) {
        req.session.cart = null;
        await Cart.findByIdAndRemove(cart._id);
      }
    }
    res.redirect(req.headers.referer);
  } catch (err) {
    console.log(err.message);
    res.redirect("/");
  }
});

// GET: remove all instances of a single product from the cart
router.get("/removeAll/:id", async function (req, res, next) {
  const productId = req.params.id;
  let cart;
  try {
    if (req.user) {
      cart = await Cart.findOne({ user: req.user._id });
    } else if (req.session.cart) {
      cart = await new Cart(req.session.cart);
    }
    //fnd the item with productId
    let itemIndex = cart.items.findIndex((p) => p.productId == productId);
    if (itemIndex > -1) {
      //find the product to find its price
      cart.totalQty -= cart.items[itemIndex].qty;
      cart.totalCost -= cart.items[itemIndex].price;
      await cart.items.remove({ _id: cart.items[itemIndex]._id });
    }
    req.session.cart = cart;
    //save the cart it only if user is logged in
    if (req.user) {
      await cart.save();
    }
    //delete cart if qty is 0
    if (cart.totalQty <= 0) {
      req.session.cart = null;
      await Cart.findByIdAndRemove(cart._id);
    }
    res.redirect(req.headers.referer);
  } catch (err) {
    console.log(err.message);
    res.redirect("/");
  }
});

// GET: checkout form with csrf token
router.get("/checkout", middleware.isLoggedIn, async (req, res) => {

  const errorMsg = req.flash("error")[0];

  if (!req.session.cart) {
    return res.redirect("/shopping-cart");
  }
  //load the cart with the session's cart's id from the db

  cart = await Cart.findById(req.session.cart._id);


  const errMsg = req.flash("error")[0];
  // res.render("shop/checkout", {
  //    key: process.env.key_id ,
  //   total: cart.totalCost,
  //   // csrfToken: req.csrfToken(),
  //   errorMsg,
  //   pageName: "Checkout",
  // });
  res.render("shop/checkout",
   { key: process.env.key_id,
        total: cart.totalCost, 
        pageName: "Checkout",
      });
});

// router.get("/checkout", middleware.isLoggedIn, async (req, res) => {
//   cart = await Cart.findById(req.session.cart._id);
//   res.render("checkout", { key: process.env.key_id,
//     total: cart.totalCost, });
// });
router.post("/api/checkout/order", (req, res) => {
  params = req.body;
  instance.orders
    .create(params)
    .then((data) => {
      res.send({ sub: data, status: "success" });
    })
    .catch((error) => {
      res.send({ sub: error, status: "failed" });
    });
});

router.post("/api/checkout/verify", (req, res) => {
  body = req.body.razorpay_order_id + "|" + req.body.razorpay_payment_id;

  var expectedSignature = crypto
    .createHmac("sha256", process.env.KEY_SECRET)
    .update(body.toString())
    .digest("hex");
  console.log("sig" + req.body.razorpay_signature);
  console.log("sig" + expectedSignature);
  var response = { status: "failure" };
  if (expectedSignature === req.body.razorpay_signature)
    response = { status: "success" };
  res.send(response);
});

// POST: handle checkout logic and payment using Stripe
// router.post("/checkout", middleware.isLoggedIn, async (req, res) => {
//   if (!req.session.cart) {
//     return res.redirect("/shopping-cart");
//   }
//   const cart = await Cart.findById(req.session.cart._id);
//   stripe.charges.create(
//     {
//       amount: cart.totalCost * 100,
//       currency: "usd",
//       source: req.body.stripeToken,
//       description: "Test charge",
//     },
//     function (err, charge) {
//       if (err) {
//         req.flash("error", err.message);
//         console.log(err);
//         return res.redirect("/checkout");
//       }
//       const order = new Order({
//         user: req.user,
//         cart: {
//           totalQty: cart.totalQty,
//           totalCost: cart.totalCost,
//           items: cart.items,
//         },
//         address: req.body.address,
//         paymentId: charge.id,
//       });
//       order.save(async (err, newOrder) => {
//         if (err) {
//           console.log(err);
//           return res.redirect("/checkout");
//         }
//         await cart.save();
//         await Cart.findByIdAndDelete(cart._id);
//         req.flash("success", "Successfully purchased");
//         req.session.cart = null;
//         res.redirect("/user/profile");
//       });
//     }
//   );
// });


/////////////////////////////////////////////////////////////////////////////

// router.post('/checkout', async(req, res)=> {
//   const cart = await Cart.findById(req.session.cart._id);
// 	params = {
// 		amount: cart.totalCost * 100,
// 		currency: "INR",
// 		receipt: nanoid(),
// 		payment_capture: "1"
// 	}
// 	razorPayInstance.orders.create(params)
// 	.then(async (response) => {
// 		const razorpayKeyId = process.env.RAZORPAY_KEY_ID
// 		// Save orderId and other payment details
// 		const paymentDetail = new PaymentDetail({
// 			orderId: response.id,
// 			receiptId: response.receipt,
// 			amount: response.amount,
// 			currency: response.currency,
// 			createdAt: response.created_at,
// 			status: response.status
// 		})
// 		try {
// 			// Render Order Confirmation page if saved succesfully
// 			await paymentDetail.save()
// 			res.render('shop/checkout', {      //--------------------???????????????????????????????????? @_@
// 				title: "Confirm Order",
// 				razorpayKeyId: razorpayKeyId,
// 				paymentDetail : paymentDetail
// 			})
// 		} catch (err) {
// 			// Throw err if failed to save
// 			if (err) throw err;
// 		}
// 	}).catch((err) => {
// 		// Throw err if failed to create order
// 		if (err) throw err;
// 	})
// });



//////////////////////////////////////////////////////////////////////////
// create products array to store the info of each product in the cart
async function productsFromCart(cart) {
  let products = []; // array of objects
  for (const item of cart.items) {
    let foundProduct = (
      await Product.findById(item.productId).populate("category")
    ).toObject();
    foundProduct["qty"] = item.qty;
    foundProduct["totalPrice"] = item.price;
    products.push(foundProduct);
  }
  return products;
}

module.exports = router;
