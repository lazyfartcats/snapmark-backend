const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const express = require('express');
const cors = require('cors');

// Send email notification
async function sendNotification(subject, message) {
    if (!process.env.RESEND_API_KEY || !process.env.ADMIN_EMAIL) {
        console.log('Email not configured, skipping notification');
        return;
    }
    
    try {
        await resend.emails.send({
            from: 'SnapMark <onboarding@resend.dev>',
            to: process.env.ADMIN_EMAIL,
            subject: subject,
            html: `
                <h2>${subject}</h2>
                <p>${message}</p>
                <hr>
                <small>SnapMark Backend Notification</small>
            `
        });
        console.log('Email notification sent');
    } catch (err) {
        console.error('Email error:', err);
    }
}

// Simple in-memory store (upgradeable to database later)
const proUsers = new Set();
global.customerMap = new Map(); // userId -> Stripe customerId

// Check if Stripe key exists
if (!process.env.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY not found!');
    console.error('Available env vars:', Object.keys(process.env));
    process.exit(1);
}

console.log('Stripe key found:', process.env.STRIPE_SECRET_KEY.substring(0, 15) + '...');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// Important: raw body for webhooks
app.use((req, res, next) => {
    if (req.originalUrl === '/webhook') {
        next();
    } else {
        express.json()(req, res, next);
    }
});

app.use(cors());

// Simple in-memory store (upgradeable to database later)
const proUsers = new Set();

// Test route
app.get('/', (req, res) => {
    res.json({ 
        service: 'SnapMark Payment Backend',
        status: 'running'
    });
});

// Check if user is Pro
app.get('/check-pro/:userId', (req, res) => {
    const { userId } = req.params;
    const isPro = proUsers.has(userId);
    console.log('Checking pro status for:', userId, isPro);
    res.json({ isPro });
});

// Create Stripe checkout session
app.post('/create-checkout', async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'User ID required' });
        }
        
        console.log('Creating checkout for user:', userId);
        
const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'subscription',
    customer_email: `${userId}@snapmark.temp`, // Temporary email
    line_items: [{
        price_data: {
            currency: 'usd',
            product_data: {
                name: 'SnapMark Pro',
                description: 'Unlimited screenshots per day',
            },
            unit_amount: 299, // $2.99
            recurring: {
                interval: 'month'
            }
        },
        quantity: 1
    }],
    metadata: {
        userId: userId
    },
    client_reference_id: userId,
    success_url: `${process.env.FRONTEND_URL || 'https://snapmark-success.netlify.app'}?success=true&userId=${userId}`,
    cancel_url: `${process.env.FRONTEND_URL || 'https://snapmark-success.netlify.app'}?cancelled=true`
});

// Create Stripe customer portal session
app.post('/create-portal-session', async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'User ID required' });
        }
        
        console.log('Looking for customer with userId:', userId);
        
        // Search for customer by metadata
        const customers = await stripe.customers.search({
            query: `metadata['userId']:'${userId}'`,
        });
        
        console.log('Found customers:', customers.data.length);
        
        if (customers.data.length === 0) {
            return res.status(404).json({ error: 'No active subscription found. Try upgrading again.' });
        }
        
        const customerId = customers.data[0].id;
        console.log('Creating portal session for customer:', customerId);
        
        const session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: `${process.env.FRONTEND_URL || 'https://snapmark-success.netlify.app'}?portal=closed`,
        });
        
        console.log('Portal session created:', session.id);
        res.json({ url: session.url });
    } catch (err) {
        console.error('Portal error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Stripe webhook - called when payment succeeds
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    
    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error('Webhook error:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    console.log('Webhook event:', event.type);
    
    // Payment succeeded - upgrade user to Pro and save customer ID
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.client_reference_id;
        const customerId = session.customer;
        
        if (userId && customerId) {
            proUsers.add(userId);
            // Store mapping of userId to customerId
            if (!global.customerMap) global.customerMap = new Map();
            global.customerMap.set(userId, customerId);
            
            console.log('User upgraded to Pro:', userId);
            console.log('Customer ID saved:', customerId);
        }
    }
    
    // Subscription cancelled - downgrade user
    if (event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        
        // Find userId by customerId
        if (global.customerMap) {
            for (let [userId, cId] of global.customerMap.entries()) {
                if (cId === customerId) {
                    proUsers.delete(userId);
                    console.log('User downgraded from Pro:', userId);
                    break;
                }
            }
        }
    }
    
    res.json({ received: true });
});

// Cancel subscription
app.post('/cancel-subscription', async (req, res) => {
    try {
        const { userId } = req.body;
        
        proUsers.delete(userId);
        console.log('Subscription cancelled for:', userId);
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log('SnapMark Payment Backend running on port', PORT);
    console.log('Pro users in memory:', proUsers.size);
});
